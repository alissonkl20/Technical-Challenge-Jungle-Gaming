import { Inject, Injectable, Logger } from "@nestjs/common";
import { errorMessage } from "../../shared/errors/error-chain.js";
import type { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import type {
  JsonLogger,
  SafeLogFields,
} from "../../shared/observability/json-logger.js";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import { EventType } from "../events/integration-event.js";
import { OutboxMessage, OutboxRetryPolicy } from "../finance/domain/index.js";
import type {
  OutboxRow,
  TransactionManager,
} from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import { OUTBOX_EVENT_PUBLISHER } from "./outbox.tokens.js";
import type {
  OutboxDispatchFailure,
  OutboxDispatchResult,
  OutboxEventPublisher,
  OutboxMessage as PublishableMessage,
} from "./types/index.js";

const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_ERROR_LENGTH = 10_000;

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly retryPolicy: OutboxRetryPolicy;

  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(OUTBOX_EVENT_PUBLISHER)
    private readonly publisher: OutboxEventPublisher,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    retryMaxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    private readonly metrics?: FinancialMetrics,
    private readonly structuredLogger?: JsonLogger,
    private readonly maxAttempts = DEFAULT_MAX_ATTEMPTS,
  ) {
    this.retryPolicy = OutboxRetryPolicy.of(retryBaseDelayMs, retryMaxDelayMs);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError("Outbox max attempts must be a positive integer");
    }
  }

  /**
   * Claims due events under a lease and publishes them one by one. Each
   * outcome is recorded only while this worker still holds the lease
   * (fencing), so an instance that lost it never overwrites another's work.
   */
  async dispatchBatch(
    workerId: string,
    limit = 10,
    leaseMs = 30_000,
  ): Promise<OutboxDispatchResult> {
    const worker = requiredWorkerId(workerId);
    assertDispatchBounds(limit, leaseMs);

    const claimed = await this.transactions.transaction(async (session) => {
      await session.outbox.recoverExpiredLeases();
      return session.outbox.claimDue(worker, limit, leaseMs);
    });
    let published = 0;
    const failures: OutboxDispatchFailure[] = [];

    for (const row of claimed) {
      const event = toEntity(row);
      await withCorrelationId(event.correlationId(), async () => {
        const failure = await this.dispatchOne(event, worker);
        if (failure === null) {
          published += 1;
        } else {
          failures.push(failure);
        }
      });
    }

    return { claimed: claimed.length, published, failures };
  }

  async refreshLagMetric(): Promise<void> {
    const { age, failed } = await this.transactions.transaction(
      async (session) => ({
        age: await session.outbox.findOldestUnpublishedAgeMs(),
        failed: await session.outbox.countFailed(),
      }),
    );
    this.metrics?.setOutboxLagMilliseconds(age);
    this.metrics?.setOutboxFailedCount(failed);
  }

  /**
   * Operator action: returns up to `limit` FAILED events to PENDING. Events
   * are only moved, never deleted or altered, so redrive is safe to repeat.
   */
  async redriveFailed(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TypeError("Redrive limit must be an integer from 1 to 10000");
    }
    return this.transactions.transaction((session) =>
      session.outbox.redriveFailed(limit),
    );
  }

  /** Publishes one claimed event. Returns null on success, else the failure. */
  private async dispatchOne(
    event: OutboxMessage,
    worker: string,
  ): Promise<OutboxDispatchFailure | null> {
    try {
      await this.publisher.publish(toTransport(event));
    } catch (error) {
      return this.recordPublishFailure(event, worker, error);
    }
    return this.acknowledgePublication(event, worker);
  }

  private async recordPublishFailure(
    event: OutboxMessage,
    worker: string,
    error: unknown,
  ): Promise<OutboxDispatchFailure> {
    this.metrics?.recordRetry("outbox");
    const message = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
    // `attempts` already counts this attempt: the claim incremented it.
    const exhausted = event.attempts >= this.maxAttempts;
    const wagerId = financialWagerOf(event);
    const scheduled = await this.transactions.transaction(async (session) => {
      const held = await session.outbox.scheduleRetry(
        event.id,
        worker,
        message,
        event.nextAttemptAt(this.retryPolicy, new Date()),
        exhausted,
      );
      // Same transaction: the wager is marked as needing recovery (or, once
      // publication is exhausted, compensation) exactly when the failed
      // attempt is recorded, and only by the lease holder.
      if (held && wagerId !== null) {
        await session.recoveries.recordPublicationFailure(
          wagerId,
          event.attempts,
          message,
          exhausted,
        );
      }
      return held;
    });
    const failure: OutboxDispatchFailure = {
      eventId: event.id,
      error: scheduled
        ? message
        : `${message}; event lease was lost before retry could be scheduled`,
    };

    if (scheduled && exhausted) {
      this.metrics?.recordOutboxExhausted();
      this.structuredLogger?.emit("error", "outbox.publish.exhausted", {
        ...eventLogFields(event),
        errorCode: "OUTBOX_EXHAUSTED",
        attempts: event.attempts,
      });
      this.logger.error(
        `Outbox event ${event.id} exhausted ${event.attempts} attempts`,
      );
      return failure;
    }
    this.structuredLogger?.emit("error", "outbox.publish.failed", {
      ...eventLogFields(event),
      errorCode: "OUTBOX_PUBLISH_FAILED",
      attempts: event.attempts,
    });
    this.logger.error(`Outbox publish failed for event ${event.id}`);
    return failure;
  }

  /**
   * Marks the event published and resolves the wager's recovery in one
   * transaction, only while the lease is still held.
   */
  private async acknowledgePublication(
    event: OutboxMessage,
    worker: string,
  ): Promise<OutboxDispatchFailure | null> {
    const wagerId = financialWagerOf(event);
    const acknowledged = await this.transactions.transaction(
      async (session) => {
        const marked = await session.outbox.markPublished(
          event.id,
          worker,
          new Date(),
        );
        if (marked && wagerId !== null) {
          await session.recoveries.markRecoveredIfPublished(wagerId);
        }
        return marked;
      },
    );
    if (!acknowledged) {
      this.logger.error(`Outbox acknowledgement failed for event ${event.id}`);
      return {
        eventId: event.id,
        error:
          "Event was published but its lease was lost before acknowledgement",
      };
    }
    this.structuredLogger?.emit("log", "outbox.publish.succeeded", {
      ...eventLogFields(event),
      status: "PUBLISHED",
    });
    return null;
  }
}

function requiredWorkerId(workerId: string): string {
  const normalized = workerId.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new TypeError("workerId must contain between 1 and 200 characters");
  }
  return normalized;
}

function assertDispatchBounds(limit: number, leaseMs: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TypeError("Outbox batch limit must be an integer from 1 to 1000");
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 1) {
    throw new TypeError("Outbox lease duration must be a positive integer");
  }
}

function toEntity(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    publishedAt: row.published_at,
  });
}

function toTransport(event: OutboxMessage): PublishableMessage {
  return {
    eventId: event.id,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    payload: event.payload,
    occurredAt: event.createdAt,
  };
}

function eventLogFields(event: OutboxMessage): SafeLogFields {
  return {
    messageId: event.id,
    transactionId: event.payloadString("wagerTransactionId"),
    walletId: event.payloadString("walletId"),
    providerId: event.payloadString("providerId"),
  };
}

/**
 * The wager a financial event reports, or null for events whose loss does not
 * leave a committed movement unannounced (rejections, pending references).
 */
function financialWagerOf(event: OutboxMessage): string | null {
  if (event.eventType === EventType.WagerTransactionProcessed) {
    return event.payloadString("wagerTransactionId");
  }
  if (event.eventType === EventType.WalletBalanceChanged) {
    return event.payloadString("transactionId");
  }
  return null;
}
