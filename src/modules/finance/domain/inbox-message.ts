import { InvalidPayloadError, InvalidStateTransitionError } from "./errors.js";
import { PayloadFingerprint } from "./payload-fingerprint.js";

export interface InboxMessageState {
  readonly id: string;
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  /** Omitted only for identities built before the row is read back. */
  readonly receivedAt?: Date | string;
  readonly processedAt?: Date | string | null;
}

export interface ReceiveInboxProps {
  readonly id: string;
  readonly consumerName: string;
  readonly messageId: string;
  readonly fingerprint: PayloadFingerprint;
  readonly receivedAt: Date;
}

/**
 * The record that a consumer has already handled a message.
 *
 * Deduplication is per consumer, not global: two consumers must each be able
 * to process the same message once. Identity is therefore
 * `(consumerName, messageId)`, enforced by a `UNIQUE` in PostgreSQL — the
 * process never decides this alone, so it stays correct across instances.
 *
 * Lifecycle: `receive` → `markProcessed`, exactly once. The row is written in
 * the same SQL transaction as the financial effect, so "processed" only
 * becomes visible together with that effect: a handler that fails rolls the
 * record back and the message is retried.
 */
export class InboxMessage {
  private constructor(
    readonly id: string,
    readonly consumerName: string,
    readonly messageId: string,
    readonly fingerprint: PayloadFingerprint,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  /** A message seen for the first time by this consumer. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.id,
      bounded(props.consumerName, "consumerName", 200),
      bounded(props.messageId, "messageId", 300),
      props.fingerprint,
      validDate(props.receivedAt, "receivedAt"),
      undefined,
    );
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    const receivedAt =
      state.receivedAt === undefined
        ? new Date()
        : validDate(state.receivedAt, "receivedAt");
    const processedAt =
      state.processedAt === undefined || state.processedAt === null
        ? undefined
        : validDate(state.processedAt, "processedAt");
    return new InboxMessage(
      state.id,
      bounded(state.consumerName, "consumerName", 200),
      bounded(state.messageId, "messageId", 300),
      PayloadFingerprint.fromDigest(state.payloadHash),
      receivedAt,
      processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /**
   * Records that the consumer handled this message. Handling twice is a
   * programming error: a redelivery is detected by the inbox and skipped, it
   * never reaches this transition.
   */
  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidStateTransitionError(
        `Inbox message ${this.consumerName}/${this.messageId} is already processed`,
      );
    }
    const processedAt = validDate(at, "processedAt");
    if (processedAt.getTime() < this.receivedAt.getTime()) {
      throw new InvalidPayloadError(
        "Inbox message cannot be processed before it was received",
      );
    }
    this._processedAt = processedAt;
  }

  /**
   * Whether a redelivery carries the same payload as the one already handled.
   *
   * A broker may redeliver, which is expected and simply skipped. The same
   * message ID carrying a *different* payload is not a redelivery: it means
   * the producer reused an ID, and skipping it would silently drop a distinct
   * financial command.
   */
  isRedeliveryOf(fingerprint: PayloadFingerprint): boolean {
    return this.fingerprint.equals(fingerprint);
  }
}

function validDate(value: Date | string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new InvalidPayloadError(`Inbox ${field} must be a valid timestamp`);
  }
  return parsed;
}

function bounded(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new InvalidPayloadError(`${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new InvalidPayloadError(
      `${field} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}
