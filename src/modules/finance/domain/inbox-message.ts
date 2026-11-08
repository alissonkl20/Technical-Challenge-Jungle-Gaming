import { InvalidPayloadError } from "./errors.js";
import { PayloadFingerprint } from "./payload-fingerprint.js";

export interface InboxMessageState {
  readonly id: string;
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

/**
 * The record that a consumer has already handled a message.
 *
 * Deduplication is per consumer, not global: two consumers must each be able
 * to process the same message once. Identity is therefore
 * `(consumerName, messageId)`, enforced by a `UNIQUE` in PostgreSQL — the
 * process never decides this alone, so it stays correct across instances.
 */
export class InboxMessage {
  private constructor(
    readonly id: string,
    readonly consumerName: string,
    readonly messageId: string,
    readonly fingerprint: PayloadFingerprint,
  ) {
    Object.freeze(this);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.id,
      bounded(state.consumerName, "consumerName", 200),
      bounded(state.messageId, "messageId", 300),
      PayloadFingerprint.fromDigest(state.payloadHash),
    );
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
