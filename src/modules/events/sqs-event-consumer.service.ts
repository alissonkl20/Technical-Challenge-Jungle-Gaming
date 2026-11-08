import type { Message, SQSClient } from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  Logger,
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
import { errorCodeOf, errorMessage } from "../../shared/errors/error-chain.js";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import { DomainError } from "../finance/domain/errors.js";
import { InboxPayloadConflictError } from "../inbox/errors/index.js";
import { InboxProcessor } from "../inbox/inbox.processor.js";
import { PermanentSqsMessageError } from "./errors/index.js";
import {
  parseFinancialEventEnvelope,
  payloadStringField,
} from "./financial-event.parser.js";
import { KNOWN_EVENT_TYPES } from "./integration-event.js";
import {
  receiveCountOf,
  retryVisibilityTimeout,
  SqsConsumerQueue,
} from "./sqs-consumer-queue.js";
import type { FinancialEventEnvelope, SqsBatchResult } from "./types/index.js";

const CONSUMER_NAME = "financial-event-consumer";

@Injectable()
export class SqsEventConsumer implements OnModuleDestroy {
  private readonly logger = new Logger(SqsEventConsumer.name);
  private readonly client: SQSClient;
  private readonly queueUrls: SqsQueueUrls;
  private readonly queue: SqsConsumerQueue;
  private readonly readinessQueueNames: readonly string[];
  private readonly settings: SqsEventSettings;

  constructor(
    @Inject(ConfigService)
    configuration: ConfigService,
    @Inject(InboxProcessor)
    private readonly inbox: InboxProcessor,
    @Optional()
    @Inject(FinancialMetrics)
    private readonly metrics?: FinancialMetrics,
    @Optional()
    @Inject(JsonLogger)
    private readonly structuredLogger?: JsonLogger,
  ) {
    const queues = sqsQueueNames(configuration);
    this.readinessQueueNames = [
      queues.outbox,
      queues.event,
      queues.eventDeadLetter,
      queues.wagerCommand,
      queues.wagerCommandDeadLetter,
    ];
    this.settings = sqsEventSettings(configuration);
    this.client = createSqsClient(configuration);
    this.queueUrls = new SqsQueueUrls(this.client);
    this.queue = new SqsConsumerQueue(
      this.client,
      this.queueUrls,
      queues.event,
      queues.eventDeadLetter,
    );
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async checkReady(): Promise<void> {
    await Promise.all(
      [...new Set(this.readinessQueueNames)].map((queueName) =>
        this.queueUrls.resolve(queueName),
      ),
    );
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
      this.logger.error("Received SQS message without a receipt handle");
      return false;
    }
    let event: FinancialEventEnvelope;
    try {
      event = parseFinancialEventEnvelope(message.Body);
    } catch (error) {
      return withCorrelationId(message.MessageId, () =>
        this.handleFailure(error, message, receiptHandle),
      );
    }

    return withCorrelationId(
      event.correlation_id,
      async () => {
        try {
          await this.recordEvent(event);
          await this.queue.acknowledge(receiptHandle);
          return true;
        } catch (error) {
          return this.handleFailure(
            error,
            message,
            receiptHandle,
            event.event_id,
          );
        }
      },
      event.event_id,
    );
  }

  private async recordEvent(event: FinancialEventEnvelope): Promise<void> {
    if (!KNOWN_EVENT_TYPES.has(event.event_type)) {
      throw new PermanentSqsMessageError(
        `Unsupported financial event type "${event.event_type}"`,
      );
    }
    const processing = await this.inbox.process(
      CONSUMER_NAME,
      event.event_id,
      event,
      async () => undefined,
    );
    if (processing.processed) {
      this.logger.log(
        `Committed ${event.event_type} event ${event.event_id} for aggregate ${event.aggregate_id}`,
      );
    } else {
      this.metrics?.recordDuplicate("replay");
    }
    this.structuredLogger?.emit("log", "sqs.event.processed", {
      messageId: event.event_id,
      transactionId: payloadStringField(event.payload, "wagerTransactionId"),
      walletId: payloadStringField(event.payload, "walletId"),
      providerId: payloadStringField(event.payload, "providerId"),
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
    eventId?: string,
  ): Promise<boolean> {
    const receiveCount = receiveCountOf(message);
    const logFields = {
      messageId: eventId ?? message.MessageId,
      errorCode: errorCodeOf(error),
    };
    if (isPermanent(error) || receiveCount >= this.settings.maxReceiveCount) {
      await this.queue.sendToDeadLetter(
        message.Body ?? "",
        message.MessageAttributes,
        errorMessage(error),
      );
      this.metrics?.recordDeadLetter();
      await this.queue.acknowledge(receiptHandle);
      this.structuredLogger?.emit("warn", "sqs.event.dead_lettered", logFields);
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
      "sqs.event.retry_scheduled",
      logFields,
    );
    this.logger.error("Transient SQS event failure; message will retry");
    return false;
  }
}

function isPermanent(error: unknown): boolean {
  return (
    error instanceof PermanentSqsMessageError ||
    error instanceof InboxPayloadConflictError ||
    error instanceof DomainError
  );
}
