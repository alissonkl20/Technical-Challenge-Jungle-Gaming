import { InvalidPayloadError } from "./errors.js";
import { PayloadFingerprint } from "./payload-fingerprint.js";
import {
  type FinancialOperationId,
  financialOperationId,
  type ProviderId,
  providerId,
} from "./types.js";

/** The stored response of an operation, as persisted for replay. */
export interface OperationResponse {
  readonly snapshot: unknown;
  readonly httpStatus: number;
  /** Status inside the snapshot, read once at rehydration. */
  readonly status: string | null;
}

export interface FinancialOperationState {
  readonly id: string;
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly payloadHash: string;
  readonly responseSnapshot: unknown;
  readonly responseHttpStatus: number;
  readonly completedAt: Date | string | null;
}

/** What a provider asserts when it sends a request. */
export interface RequestIdentity {
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
  readonly fingerprint: PayloadFingerprint;
}

export type ReplayDecision =
  /** The stored response is final: serve it verbatim. */
  | { readonly kind: "replay"; readonly operation: FinancialOperation }
  /**
   * The operation exists but is still waiting on a reference, so this request
   * continues it instead of being answered from the snapshot.
   */
  | { readonly kind: "resume"; readonly operation: FinancialOperation }
  /** The identity was reused for a different request. */
  | {
      readonly kind: "conflict";
      readonly reason: ConflictReason;
      readonly storedDigest: string;
    };

export const ConflictReason = {
  /** Same key, different payload. */
  PayloadChanged: "PAYLOAD_CHANGED",
  /** The key and the external transaction ID point at different operations. */
  IdentitySplit: "IDENTITY_SPLIT",
} as const;

export type ConflictReason =
  (typeof ConflictReason)[keyof typeof ConflictReason];

const PENDING_REFERENCE_STATUS = "PENDING_REFERENCE";

/**
 * One attempt by a provider to change money, and the owner of the request
 * identity: the idempotency key, the payload fingerprint and the response
 * snapshot served to a replay.
 *
 * It is deliberately separate from the wager transaction. A rejected request
 * has an operation and no financial fact, and a request still waiting on its
 * reference has an operation whose response is not final yet. Collapsing the
 * two into one table would force one of those states to lie.
 */
export class FinancialOperation {
  private constructor(
    readonly id: FinancialOperationId,
    readonly providerId: ProviderId,
    readonly idempotencyKey: string,
    readonly externalTransactionId: string,
    readonly fingerprint: PayloadFingerprint,
    readonly response: OperationResponse,
    readonly completedAt: Date | null,
  ) {
    Object.freeze(this);
  }

  static rehydrate(state: FinancialOperationState): FinancialOperation {
    const completedAt =
      state.completedAt === null ? null : new Date(state.completedAt);
    if (completedAt !== null && Number.isNaN(completedAt.getTime())) {
      throw new InvalidPayloadError(
        "Financial operation completedAt must be a valid timestamp",
      );
    }

    return new FinancialOperation(
      financialOperationId(state.id),
      providerId(state.providerId),
      requiredIdentity(state.idempotencyKey, "idempotencyKey"),
      requiredIdentity(state.externalTransactionId, "externalTransactionId"),
      PayloadFingerprint.fromDigest(state.payloadHash),
      {
        snapshot: state.responseSnapshot,
        httpStatus: state.responseHttpStatus,
        status: readStatus(state.responseSnapshot),
      },
      completedAt,
    );
  }

  matchesPayload(fingerprint: PayloadFingerprint): boolean {
    return this.fingerprint.equals(fingerprint);
  }

  isCompleted(): boolean {
    return this.completedAt !== null;
  }

  /**
   * An operation whose stored response is not final: it was answered with
   * PENDING_REFERENCE and no completion timestamp, so a retry of the same
   * request should continue processing rather than replay that answer.
   */
  isAwaitingReference(): boolean {
    return (
      !this.isCompleted() && this.response.status === PENDING_REFERENCE_STATUS
    );
  }

  /**
   * Decides what a request whose reservation lost the `UNIQUE` race should
   * get. The caller has already looked the two identities up; this method owns
   * the rule, so it is decided without a database.
   *
   * Reserving first and deciding here is what makes the guarantee hold across
   * instances: the database, not this process, arbitrates who wins.
   */
  static resolveReplay(
    identity: RequestIdentity,
    byIdempotencyKey: FinancialOperation | null,
    byExternalTransactionId: FinancialOperation | null,
  ): ReplayDecision | null {
    if (
      byIdempotencyKey !== null &&
      byExternalTransactionId !== null &&
      byIdempotencyKey.id !== byExternalTransactionId.id
    ) {
      // The key was used for one transaction and the transaction ID for
      // another. Serving either response would answer a question the provider
      // did not ask.
      return {
        kind: "conflict",
        reason: ConflictReason.IdentitySplit,
        storedDigest: byIdempotencyKey.fingerprint.toString(),
      };
    }

    const existing = byIdempotencyKey ?? byExternalTransactionId;
    if (existing === null) {
      // Neither identity is present, so the reservation conflicted on
      // something the caller did not anticipate. It must not be treated as a
      // replay; the caller raises this as a failed invariant.
      return null;
    }

    if (!existing.matchesPayload(identity.fingerprint)) {
      return {
        kind: "conflict",
        reason: ConflictReason.PayloadChanged,
        storedDigest: existing.fingerprint.toString(),
      };
    }

    return existing.isAwaitingReference()
      ? { kind: "resume", operation: existing }
      : { kind: "replay", operation: existing };
  }
}

function requiredIdentity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPayloadError(`${field} must not be empty`);
  }
  return value;
}

function readStatus(snapshot: unknown): string | null {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    return null;
  }
  const status = (snapshot as Record<string, unknown>).status;
  return typeof status === "string" ? status : null;
}
