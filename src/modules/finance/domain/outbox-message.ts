import { InvalidPayloadError } from "./errors.js";

export const OutboxStatus = {
  Pending: "PENDING",
  Processing: "PROCESSING",
  Published: "PUBLISHED",
  /** Attempts exhausted. Terminal: never claimed automatically, only redriven. */
  Failed: "FAILED",
} as const;

export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly status: string;
  readonly attempts: number;
  readonly createdAt: Date | string;
  readonly publishedAt: Date | string | null;
}

/** Exponential backoff bounds for republishing a failed event. */
export class OutboxRetryPolicy {
  private constructor(
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
  ) {
    Object.freeze(this);
  }

  static of(baseDelayMs: number, maxDelayMs: number): OutboxRetryPolicy {
    if (
      !Number.isInteger(baseDelayMs) ||
      baseDelayMs < 0 ||
      !Number.isInteger(maxDelayMs) ||
      maxDelayMs < baseDelayMs
    ) {
      throw new InvalidPayloadError(
        "Outbox retry delays must be non-negative integers with max >= base",
      );
    }
    return new OutboxRetryPolicy(baseDelayMs, maxDelayMs);
  }

  /**
   * `base * 2^(attempts - 1)`, capped at `maxDelayMs`. The exponent is clamped
   * at zero so the first attempt waits exactly the base delay, and the cap is
   * applied before any large shift can overflow into `Infinity`.
   */
  delayAfter(attempts: number): number {
    if (!Number.isInteger(attempts) || attempts < 0) {
      throw new InvalidPayloadError("Outbox attempts must not be negative");
    }
    const exponent = Math.max(0, attempts - 1);
    if (exponent > 52) {
      return this.maxDelayMs;
    }
    return Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
  }
}

/**
 * An event recorded in the same transaction as the financial fact it
 * describes, published only after that transaction commits.
 *
 * This is what makes "never publish before the commit" structural rather than
 * a convention: a publisher reads committed rows, so an event for a rolled
 * back transaction does not exist to be read. The cost is at-least-once
 * delivery, which the inbox absorbs on the consuming side.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: unknown,
    readonly status: OutboxStatus,
    readonly attempts: number,
    readonly createdAt: Date,
    readonly publishedAt: Date | null,
  ) {
    Object.freeze(this);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    const createdAt = timestamp(state.createdAt, "createdAt");
    const publishedAt =
      state.publishedAt === null
        ? null
        : timestamp(state.publishedAt, "publishedAt");
    if (!Number.isInteger(state.attempts) || state.attempts < 0) {
      throw new InvalidPayloadError("Outbox attempts must not be negative");
    }

    return new OutboxMessage(
      state.id,
      state.aggregateId,
      nonEmpty(state.eventType, "eventType"),
      state.payload,
      assertStatus(state.status),
      state.attempts,
      createdAt,
      publishedAt,
    );
  }

  isPublished(): boolean {
    return this.status === OutboxStatus.Published;
  }

  /** When the next attempt is due after this one failed. */
  nextAttemptAt(policy: OutboxRetryPolicy, now: Date): Date {
    return new Date(now.getTime() + policy.delayAfter(this.attempts));
  }

  /**
   * The correlation identifier to log this event under. Falling back to the
   * event ID keeps every published event traceable even when its payload
   * carries no correlation field.
   */
  correlationId(): string {
    return (
      this.payloadString("correlationId") ??
      this.payloadString("wagerTransactionId") ??
      this.payloadString("financialOperationId") ??
      this.id
    );
  }

  /**
   * Reads a string from the stored envelope, looking at the envelope itself
   * and then inside its `data`. Business identifiers such as the transaction
   * or wallet live in `data`, while tracing fields live on the envelope, and
   * logging needs both without knowing which is which.
   */
  payloadString(key: string): string | null {
    const envelope = asRecord(this.payload);
    if (envelope === null) {
      return null;
    }
    const direct = envelope[key];
    if (typeof direct === "string") {
      return direct;
    }
    const data = asRecord(envelope.data);
    const nested = data === null ? undefined : data[key];
    return typeof nested === "string" ? nested : null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertStatus(value: string): OutboxStatus {
  if (
    value !== OutboxStatus.Pending &&
    value !== OutboxStatus.Processing &&
    value !== OutboxStatus.Published &&
    value !== OutboxStatus.Failed
  ) {
    throw new InvalidPayloadError(`Unknown outbox status: ${value}`);
  }
  return value;
}

function timestamp(value: Date | string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidPayloadError(`Outbox ${field} must be a valid timestamp`);
  }
  return parsed;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPayloadError(`Outbox ${field} must not be empty`);
  }
  return value;
}
