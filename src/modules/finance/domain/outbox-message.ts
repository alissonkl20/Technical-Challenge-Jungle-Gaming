import { InvalidPayloadError, InvalidStateTransitionError } from "./errors.js";

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
  /** Defaults to `createdAt` when the row predates the read (tests, fixtures). */
  readonly nextAttemptAt?: Date | string;
  readonly lastError?: string | null;
}

/**
 * What the outbox needs from an integration event. Declared here, as a shape,
 * so the domain does not depend on the events module that implements it.
 */
export interface OutboxEnqueueable {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  toJSON(): unknown;
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
 *
 * Valid transitions:
 *
 *   enqueue → PENDING ──claim──► PROCESSING ──markPublished──► PUBLISHED
 *                ▲                   │
 *                └── scheduleRetry ──┤ (attempts < max)
 *                                    └── scheduleRetry ──► FAILED (attempts = max)
 *
 * The claim itself is a single SQL statement (`FOR UPDATE SKIP LOCKED` plus a
 * lease), because only PostgreSQL can arbitrate between concurrent
 * publishers; it counts the attempt, so a publisher that dies mid-send still
 * consumes budget. Every transition after the claim is decided here and then
 * persisted under the lease (fencing). PUBLISHED and FAILED are terminal for
 * the publisher; FAILED only leaves through the operator's redrive.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: unknown,
    readonly createdAt: Date,
    private _status: OutboxStatus,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt: Date | null,
    private _lastError: string | null,
  ) {}

  /**
   * A new event to publish, due immediately. The payload is the event's
   * serialized envelope, captured once so the stored row cannot drift from
   * the typed event that produced it.
   */
  static enqueue(event: OutboxEnqueueable): OutboxMessage {
    const occurredAt = timestamp(event.occurredAt, "occurredAt");
    return new OutboxMessage(
      nonEmpty(event.eventId, "eventId"),
      nonEmpty(event.aggregateId, "aggregateId"),
      nonEmpty(event.eventType, "eventType"),
      event.toJSON(),
      occurredAt,
      OutboxStatus.Pending,
      0,
      occurredAt,
      null,
      null,
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
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
      createdAt,
      assertStatus(state.status),
      state.attempts,
      state.nextAttemptAt === undefined
        ? createdAt
        : timestamp(state.nextAttemptAt, "nextAttemptAt"),
      publishedAt,
      state.lastError ?? null,
    );
  }

  get status(): OutboxStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  isPending(): boolean {
    return this._status === OutboxStatus.Pending;
  }

  isPublished(): boolean {
    return this._status === OutboxStatus.Published;
  }

  /** Attempts exhausted: only an operator redrive brings it back. */
  isExhausted(): boolean {
    return this._status === OutboxStatus.Failed;
  }

  /** Whether a publisher may claim this event now. */
  isDue(now: Date): boolean {
    return (
      this._status === OutboxStatus.Pending &&
      this._nextAttemptAt.getTime() <= now.getTime()
    );
  }

  /** The claimed event was accepted by the broker. */
  markPublished(at: Date): void {
    this.assertClaimed("mark as published");
    // No ordering check against `createdAt`: that column is stamped by the
    // database clock and `at` by the worker's, and a small skew between them
    // must never block a publication.
    const publishedAt = timestamp(at, "publishedAt");
    this._status = OutboxStatus.Published;
    this._publishedAt = publishedAt;
    this._lastError = null;
  }

  /**
   * Records a failed attempt on the claimed event. With budget left it goes
   * back to PENDING, due after the policy's exponential backoff; once
   * `attempts` reaches `maxAttempts` it becomes FAILED and is never claimed
   * again automatically. `attempts` already counts this attempt (the claim
   * incremented it), so it is not incremented a second time here.
   */
  scheduleRetry(
    now: Date,
    policy: OutboxRetryPolicy,
    maxAttempts: number,
    error: string,
  ): void {
    this.assertClaimed("schedule a retry for");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new InvalidPayloadError(
        "Outbox max attempts must be a positive integer",
      );
    }
    this._lastError = error;
    if (this._attempts >= maxAttempts) {
      this._status = OutboxStatus.Failed;
      return;
    }
    this._status = OutboxStatus.Pending;
    this._nextAttemptAt = new Date(
      now.getTime() + policy.delayAfter(this._attempts),
    );
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

  private assertClaimed(action: string): void {
    if (this._status !== OutboxStatus.Processing) {
      throw new InvalidStateTransitionError(
        `Cannot ${action} outbox event ${this.id} in status ${this._status}`,
      );
    }
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
