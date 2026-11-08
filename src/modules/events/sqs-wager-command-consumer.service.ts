import { createHash } from "node:crypto";
import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type SqsEventSettings,
  sqsEventSettings,
  sqsQueueNames,
} from "../../config/settings.js";
import { createSqsClient, SqsQueueUrls } from "../../shared/aws/sqs-client.js";
import { errorCodeOf } from "../../shared/errors/error-chain.js";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import { DomainError } from "../finance/domain/index.js";
import type { PersistenceSession } from "../finance/persistence/repositories.js";
import { InboxPayloadConflictError } from "../inbox/errors/index.js";
import { InboxProcessor } from "../inbox/inbox.processor.js";
import type { WagerProcessingResult } from "../transactions/types/index.js";
import {
  assertReplayAddressesWallet,
  resolveSubmittedWagerIdentity,
} from "../transactions/wager-submission-identity.js";
import { WagerTransactionsService } from "../transactions/wager-transactions.service.js";
import { PermanentSqsMessageError } from "./errors/index.js";
import {
  receiveCountOf,
  retryVisibilityTimeout,
  SqsConsumerQueue,
} from "./sqs-consumer-queue.js";
import type { SqsBatchResult, WagerCommand } from "./types/index.js";
import { parseWagerCommand } from "./wager-command.parser.js";

const CONSUMER_NAME = "wager-command-consumer";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SqsWagerCommandConsumer implements OnModuleDestroy {
  private readonly client: SQSClient;
  private readonly queue: SqsConsumerQueue;
  private readonly settings: SqsEventSettings;

  constructor(
    @Inject(ConfigService) configuration: ConfigService,
    @Inject(InboxProcessor) private readonly inbox: InboxProcessor,
    @Inject(WagerTransactionsService)
    private readonly wagers: WagerTransactionsService,
    @Optional()
    @Inject(FinancialMetrics)
    private readonly metrics?: FinancialMetrics,
    @Optional()
    @Inject(JsonLogger)
    private readonly structuredLogger?: JsonLogger,
  ) {
    const queues = sqsQueueNames(configuration);
    this.settings = sqsEventSettings(configuration);
    this.client = createSqsClient(configuration);
    this.queue = new SqsConsumerQueue(
      this.client,
      new SqsQueueUrls(this.client),
      queues.wagerCommand,
      queues.wagerCommandDeadLetter,
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async receiveBatch(abortSignal?: AbortSignal): Promise<SqsBatchResult> {
    const messages = await this.queue.receive(this.settings, abortSignal);
    let acknowledged = 0;
    for (const message of messages) {
      if (await this.handleMessage(message)) {
        acknowledged += 1;
      }
    }
    return { received: messages.length, acknowledged };
  }

  /** Returns whether the message was acknowledged (processed or dead-lettered). */
  private async handleMessage(message: Message): Promise<boolean> {
    const receiptHandle = message.ReceiptHandle;
    if (receiptHandle === undefined) {
      return false;
    }
    let command: WagerCommand;
    try {
      command = parseWagerCommand(message.Body);
    } catch (error) {
      // A malformed message has no business flow. Its ID is the cause of
      // this handling, never a correlation.
      return withCorrelationId(
        undefined,
        () => this.handleFailure(error, message, receiptHandle),
        message.MessageId,
      );
    }

    // The producer's correlation ID keeps the flow linked end to end. The
    // message ID is the cause of this work, so it is recorded as causation
    // and never used as a substitute for the correlation.
    return withCorrelationId(
      command.correlationId,
      async () => {
        try {
          await this.processCommand(command);
          await this.queue.acknowledge(receiptHandle);
          return true;
        } catch (error) {
          return this.handleFailure(error, message, receiptHandle, command);
        }
      },
      command.messageId,
    );
  }

  private async processCommand(command: WagerCommand): Promise<void> {
    const result = await this.inbox.process(
      CONSUMER_NAME,
      command.messageId,
      command,
      (session, payload) => this.executeCommand(session, payload),
    );
    if (!result.processed) {
      this.metrics?.recordDuplicate("replay");
    }
    this.structuredLogger?.emit("log", "sqs.wager_command.processed", {
      messageId: command.messageId,
      providerId: command.data.providerId,
      transactionId: command.data.input.externalTransactionId,
      walletId: command.data.walletId,
      status: result.processed ? result.result.response.status : "DUPLICATE",
    });
  }

  /**
   * Dead-letters a permanent failure, or one past the receive limit, and
   * acknowledges it. Anything else is retried later with a longer visibility.
   * Returns whether the message was acknowledged.
   */
  private async handleFailure(
    error: unknown,
    message: Message,
    receiptHandle: string,
    command?: WagerCommand,
  ): Promise<boolean> {
    const receiveCount = receiveCountOf(message);
    const logFields = {
      messageId: command?.messageId ?? message.MessageId,
      providerId: command?.data.providerId,
      transactionId: command?.data.input.externalTransactionId,
      walletId: command?.data.walletId,
      errorCode: errorCodeOf(error),
    };

    if (isPermanent(error) || receiveCount >= this.settings.maxReceiveCount) {
      const body = message.Body ?? "";
      await this.queue.sendToDeadLetter(
        body,
        message.MessageAttributes,
        error instanceof Error ? error.message : "unknown",
        message.MessageId ?? createHash("sha256").update(body).digest("hex"),
      );
      this.metrics?.recordDeadLetter();
      await this.queue.acknowledge(receiptHandle);
      this.structuredLogger?.emit(
        "warn",
        "sqs.wager_command.dead_lettered",
        logFields,
      );
      return true;
    }

    await this.queue.retryLater(
      receiptHandle,
      retryVisibilityTimeout(
        this.settings.retryVisibilitySeconds,
        receiveCount,
      ),
    );
    this.metrics?.recordRetry("sqs");
    this.structuredLogger?.emit(
      "error",
      "sqs.wager_command.retry_scheduled",
      logFields,
    );
    return false;
  }

  private async executeCommand(
    session: PersistenceSession,
    command: WagerCommand,
  ): Promise<WagerProcessingResult> {
    const { playerId, walletId, input, idempotencyKey } = command.data;
    const providerId = await this.resolveProviderId(
      session,
      command.data.providerId,
    );
    // The same resolution the HTTP contract uses: an unknown player, a wallet
    // of another player, or a currency mismatch is a business rejection. It is
    // recorded as REJECTED through the idempotency reservation and the message
    // is acknowledged, instead of being dead-lettered without an audit record.
    const { externalPlayerId, rejection } = await resolveSubmittedWagerIdentity(
      session,
      providerId,
      { playerId, walletId, currency: input.currency },
    );
    const result = await this.wagers.process(
      providerId,
      idempotencyKey,
      {
        ...input,
        externalPlayerId,
        ...(rejection === undefined ? {} : { rejection }),
      },
      session,
    );
    assertReplayAddressesWallet(result, idempotencyKey, walletId);
    return result;
  }

  /**
   * The message may name the provider by code (the published example uses
   * "provider-a") or by UUID, as the HTTP API accepts. Either way the
   * financial work uses the canonical UUID.
   */
  private async resolveProviderId(
    session: PersistenceSession,
    providerReference: string,
  ): Promise<string> {
    const providerRow = UUID_PATTERN.test(providerReference)
      ? await session.providers.findById(providerReference)
      : await session.providers.findByCode(providerReference);
    if (providerRow === null) {
      throw new PermanentSqsMessageError("Wager command provider is unknown");
    }
    return providerRow.id;
  }
}

/**
 * Failures that cannot succeed on redelivery. `TypeError` covers a command
 * whose shape passed parsing but still broke the use case.
 */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentSqsMessageError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof DomainError ||
    error instanceof TypeError
  );
}
