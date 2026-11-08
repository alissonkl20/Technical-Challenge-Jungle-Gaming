import {
  IdempotencyConflictError,
  IdempotencyReplayError,
  InvalidPayloadError,
  InvalidStateTransitionError,
  InvalidWagerTransactionError,
} from "./errors.js";
import { type FailureCode, isFailureCode } from "./failure-code.js";
import { Money } from "./money.js";
import {
  type FinancialOperationId,
  financialOperationId,
  type PlayerId,
  type ProviderId,
  playerId,
  providerId,
  type WagerTransactionId,
  type WalletId,
  wagerTransactionId,
  walletId,
} from "./types.js";
import { LedgerDirection } from "./wallet-ledger-entry.js";

export const WagerTransactionKind = {
  OPENING: "OPENING",
  BET: "BET",
  WIN: "WIN",
  LOSS: "LOSS",
  REFUND: "REFUND",
  ROLLBACK: "ROLLBACK",
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  PENDING: "PENDING",
  PENDING_REFERENCE: "PENDING_REFERENCE",
  PROCESSED: "PROCESSED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

const EXTERNAL_KINDS = new Set<WagerTransactionKind>([
  WagerTransactionKind.BET,
  WagerTransactionKind.WIN,
  WagerTransactionKind.LOSS,
  WagerTransactionKind.REFUND,
  WagerTransactionKind.ROLLBACK,
]);
const STATUSES = new Set<string>(Object.values(WagerTransactionStatus));
const TERMINAL_STATUSES = new Set<WagerTransactionStatus>([
  WagerTransactionStatus.PROCESSED,
  WagerTransactionStatus.REJECTED,
  WagerTransactionStatus.FAILED,
]);
const FINGERPRINT_PATTERN = /^[a-f\d]{64}$/i;

export interface CreateWagerTransactionInput {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly financialOperationId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadFingerprint: string;
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly currency: string;
  readonly externalReferenceTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly createdAt?: string;
}

export interface CreateOpeningTransactionInput {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly amount: string;
  readonly currency: string;
  readonly createdAt?: string;
}

export interface WagerTransactionSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly financialOperationId: string | null;
  readonly externalTransactionId: string | null;
  readonly idempotencyKey: string | null;
  readonly payloadFingerprint: string | null;
  readonly externalReferenceTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly status: WagerTransactionStatus;
  readonly amount: string;
  readonly currency: string;
  readonly failureCode: FailureCode | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly completedAt: string | null;
}

interface WagerTransactionState {
  readonly id: WagerTransactionId;
  readonly providerId: ProviderId;
  readonly playerId: PlayerId;
  readonly walletId: WalletId;
  readonly financialOperationId: FinancialOperationId | null;
  readonly externalTransactionId: string | null;
  readonly idempotencyKey: string | null;
  readonly payloadFingerprint: string | null;
  readonly externalReferenceTransactionId: string | null;
  referenceTransactionId: WagerTransactionId | null;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: WagerTransactionKind;
  readonly amount: Money;
  readonly createdAt: string;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidPayloadError(`${field} must be a non-empty string`);
  }

  return value;
}

function timestamp(
  value: string | undefined,
  field: string,
  defaultToNow = true,
): string {
  const resolved = value ?? (defaultToNow ? new Date().toISOString() : "");
  if (Number.isNaN(Date.parse(resolved))) {
    throw new InvalidPayloadError(`${field} must be a valid timestamp`);
  }
  return new Date(resolved).toISOString();
}

function validatePositiveAmount(amount: Money): void {
  if (!amount.isPositive()) {
    throw new InvalidPayloadError(
      "Transaction amount must be greater than zero",
    );
  }
}

export class WagerTransaction {
  private statusValue: WagerTransactionStatus;
  private failureCodeValue: FailureCode | null;
  private processedAtValue: string | null;
  private completedAtValue: string | null;

  private constructor(
    private readonly state: WagerTransactionState,
    status: WagerTransactionStatus,
    failureCode: FailureCode | null,
    processedAt: string | null,
    completedAt: string | null,
  ) {
    this.statusValue = status;
    this.failureCodeValue = failureCode;
    this.processedAtValue = processedAt;
    this.completedAtValue = completedAt;
  }

  static create(
    input: CreateWagerTransactionInput,
    existingIdempotency?: {
      readonly key: string;
      readonly payloadFingerprint: string;
    },
  ): WagerTransaction {
    if (!EXTERNAL_KINDS.has(input.kind)) {
      throw new InvalidPayloadError("OPENING transactions are internal only");
    }
    if (
      typeof input.payloadFingerprint !== "string" ||
      !FINGERPRINT_PATTERN.test(input.payloadFingerprint)
    ) {
      throw new InvalidPayloadError(
        "Payload fingerprint must be a SHA-256 hex digest",
      );
    }

    const idempotencyKey = nonEmpty(input.idempotencyKey, "idempotencyKey");
    const payloadFingerprint = input.payloadFingerprint.toLowerCase();
    if (
      existingIdempotency?.key === idempotencyKey &&
      existingIdempotency.payloadFingerprint.toLowerCase() !==
        payloadFingerprint
    ) {
      throw new IdempotencyConflictError(
        idempotencyKey,
        existingIdempotency.payloadFingerprint,
        payloadFingerprint,
      );
    }
    if (existingIdempotency?.key === idempotencyKey) {
      throw new IdempotencyReplayError(idempotencyKey, payloadFingerprint);
    }

    const amount = Money.fromDecimal(input.amount, input.currency);
    validatePositiveAmount(amount);
    const state: WagerTransactionState = {
      id: wagerTransactionId(input.id),
      providerId: providerId(input.providerId),
      playerId: playerId(input.playerId),
      walletId: walletId(input.walletId),
      financialOperationId: financialOperationId(input.financialOperationId),
      externalTransactionId: nonEmpty(
        input.externalTransactionId,
        "externalTransactionId",
      ),
      idempotencyKey,
      payloadFingerprint,
      externalReferenceTransactionId:
        input.externalReferenceTransactionId === undefined
          ? null
          : nonEmpty(
              input.externalReferenceTransactionId,
              "externalReferenceTransactionId",
            ),
      referenceTransactionId:
        input.referenceTransactionId === undefined
          ? null
          : wagerTransactionId(input.referenceTransactionId),
      roundId:
        input.roundId === undefined ? null : nonEmpty(input.roundId, "roundId"),
      gameId:
        input.gameId === undefined ? null : nonEmpty(input.gameId, "gameId"),
      kind: input.kind,
      amount,
      createdAt: timestamp(input.createdAt, "createdAt"),
    };

    const referenced = state.externalReferenceTransactionId !== null;
    if (kindRequiresReference(input.kind) && !referenced) {
      throw new InvalidPayloadError(
        `${input.kind} requires a transaction reference`,
      );
    }
    if (!kindAcceptsReference(input.kind) && referenced) {
      throw new InvalidPayloadError(
        `${input.kind} cannot reference another transaction`,
      );
    }

    return new WagerTransaction(
      state,
      WagerTransactionStatus.PENDING,
      null,
      null,
      null,
    );
  }

  static createOpening(input: CreateOpeningTransactionInput): WagerTransaction {
    const amount = Money.fromDecimal(input.amount, input.currency);
    validatePositiveAmount(amount);

    return new WagerTransaction(
      {
        id: wagerTransactionId(input.id),
        providerId: providerId(input.providerId),
        playerId: playerId(input.playerId),
        walletId: walletId(input.walletId),
        financialOperationId: null,
        externalTransactionId: null,
        idempotencyKey: null,
        payloadFingerprint: null,
        externalReferenceTransactionId: null,
        referenceTransactionId: null,
        roundId: null,
        gameId: null,
        kind: WagerTransactionKind.OPENING,
        amount,
        createdAt: timestamp(input.createdAt, "createdAt"),
      },
      WagerTransactionStatus.PENDING,
      null,
      null,
      null,
    );
  }

  static rehydrate(snapshot: WagerTransactionSnapshot): WagerTransaction {
    if (!Object.values(WagerTransactionKind).includes(snapshot.kind)) {
      throw new InvalidWagerTransactionError("Unknown transaction kind");
    }
    if (!STATUSES.has(snapshot.status)) {
      throw new InvalidWagerTransactionError("Unknown transaction status");
    }

    const amount = Money.fromDecimal(snapshot.amount, snapshot.currency);
    validatePositiveAmount(amount);
    const isOpening = snapshot.kind === WagerTransactionKind.OPENING;
    if (
      isOpening &&
      snapshot.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      throw new InvalidWagerTransactionError(
        "OPENING transactions cannot wait for an external reference",
      );
    }
    if (isOpening !== (snapshot.financialOperationId === null)) {
      throw new InvalidWagerTransactionError(
        "Only OPENING transactions may omit a financial operation",
      );
    }
    if (isOpening !== (snapshot.externalTransactionId === null)) {
      throw new InvalidWagerTransactionError(
        "Only OPENING transactions may omit an external transaction ID",
      );
    }

    const processedAt =
      snapshot.processedAt === null
        ? null
        : timestamp(snapshot.processedAt, "processedAt", false);
    const completedAt =
      snapshot.completedAt === null
        ? null
        : timestamp(snapshot.completedAt, "completedAt", false);
    if (TERMINAL_STATUSES.has(snapshot.status) !== (completedAt !== null)) {
      throw new InvalidWagerTransactionError(
        "Terminal transactions must have a completion timestamp",
      );
    }
    if (
      (snapshot.status === WagerTransactionStatus.PROCESSED) !==
      (processedAt !== null)
    ) {
      throw new InvalidWagerTransactionError(
        "Only processed transactions must have a processing timestamp",
      );
    }
    if (
      (snapshot.status === WagerTransactionStatus.FAILED ||
        snapshot.status === WagerTransactionStatus.REJECTED) !==
      (snapshot.failureCode !== null)
    ) {
      throw new InvalidWagerTransactionError(
        "Failed and rejected transactions require a failure code",
      );
    }
    if (snapshot.failureCode !== null && !isFailureCode(snapshot.failureCode)) {
      throw new InvalidWagerTransactionError(
        `Unknown persisted failure code "${snapshot.failureCode}"`,
      );
    }

    const isExternal = !isOpening;
    // The request identity — idempotency key and payload fingerprint — is
    // owned by the FinancialOperation, not by the wager table. A transaction
    // reconstructed from its own row alone therefore legitimately has neither,
    // and `matchesPayload` answers false while the fingerprint is unknown.
    if (
      snapshot.payloadFingerprint !== null &&
      !FINGERPRINT_PATTERN.test(snapshot.payloadFingerprint)
    ) {
      throw new InvalidWagerTransactionError(
        "Payload fingerprint must be a SHA-256 hex digest",
      );
    }
    if (
      !isExternal &&
      (snapshot.idempotencyKey !== null ||
        snapshot.payloadFingerprint !== null ||
        snapshot.externalReferenceTransactionId !== null ||
        snapshot.referenceTransactionId !== null)
    ) {
      throw new InvalidWagerTransactionError(
        "OPENING transactions cannot have external request or reference data",
      );
    }

    const state: WagerTransactionState = {
      id: wagerTransactionId(snapshot.id),
      providerId: providerId(snapshot.providerId),
      playerId: playerId(snapshot.playerId),
      walletId: walletId(snapshot.walletId),
      financialOperationId:
        snapshot.financialOperationId === null
          ? null
          : financialOperationId(snapshot.financialOperationId),
      externalTransactionId:
        snapshot.externalTransactionId === null
          ? null
          : nonEmpty(snapshot.externalTransactionId, "externalTransactionId"),
      idempotencyKey:
        snapshot.idempotencyKey === null
          ? null
          : nonEmpty(snapshot.idempotencyKey, "idempotencyKey"),
      payloadFingerprint: snapshot.payloadFingerprint?.toLowerCase() ?? null,
      externalReferenceTransactionId:
        snapshot.externalReferenceTransactionId === null
          ? null
          : nonEmpty(
              snapshot.externalReferenceTransactionId,
              "externalReferenceTransactionId",
            ),
      referenceTransactionId:
        snapshot.referenceTransactionId === null
          ? null
          : wagerTransactionId(snapshot.referenceTransactionId),
      roundId:
        snapshot.roundId === null
          ? null
          : nonEmpty(snapshot.roundId, "roundId"),
      gameId:
        snapshot.gameId === null ? null : nonEmpty(snapshot.gameId, "gameId"),
      kind: snapshot.kind,
      amount,
      createdAt: timestamp(snapshot.createdAt, "createdAt", false),
    };

    return new WagerTransaction(
      state,
      snapshot.status,
      snapshot.failureCode,
      processedAt,
      completedAt,
    );
  }

  get id(): WagerTransactionId {
    return this.state.id;
  }

  get kind(): WagerTransactionKind {
    return this.state.kind;
  }

  get status(): WagerTransactionStatus {
    return this.statusValue;
  }

  get amount(): Money {
    return this.state.amount;
  }

  get providerId(): ProviderId {
    return this.state.providerId;
  }

  get playerId(): PlayerId {
    return this.state.playerId;
  }

  get walletId(): WalletId {
    return this.state.walletId;
  }

  get roundId(): string | undefined {
    return this.state.roundId ?? undefined;
  }

  get externalTransactionId(): string | undefined {
    return this.state.externalTransactionId ?? undefined;
  }

  get externalReferenceTransactionId(): string | undefined {
    return this.state.externalReferenceTransactionId ?? undefined;
  }

  get failureCode(): FailureCode | undefined {
    return this.failureCodeValue ?? undefined;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId ?? undefined;
  }

  get processedAt(): string | undefined {
    return this.processedAtValue ?? undefined;
  }

  /** PROCESSED, REJECTED and FAILED never change again. */
  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this.statusValue);
  }

  /** False for LOSS, which records a result without moving money. */
  affectsBalance(): boolean {
    return this.state.kind !== WagerTransactionKind.LOSS;
  }

  /** True for REFUND and ROLLBACK, which always reverse another operation. */
  requiresReference(): boolean {
    return kindRequiresReference(this.state.kind);
  }

  /** True for REFUND and ROLLBACK, which give money back and must match it. */
  isReversal(): boolean {
    return (
      this.state.kind === WagerTransactionKind.REFUND ||
      this.state.kind === WagerTransactionKind.ROLLBACK
    );
  }

  /**
   * True for WIN, LOSS and REFUND: the possible results of a BET. When one
   * names its BET, the BET has at most one active result and the first valid
   * one recorded wins.
   */
  isBetResult(): boolean {
    return isBetResultKind(this.state.kind);
  }

  matchesPayload(payloadFingerprint: string): boolean {
    return (
      this.state.payloadFingerprint !== null &&
      this.state.payloadFingerprint === payloadFingerprint.toLowerCase()
    );
  }

  /**
   * Direction of the ledger line this operation produces, or null when it
   * produces none. A ROLLBACK inverts the direction of its reference, so it
   * needs the referenced kind to decide.
   */
  ledgerDirectionFor(
    referenceKind?: WagerTransactionKind,
  ): LedgerDirection | null {
    switch (this.state.kind) {
      case WagerTransactionKind.BET:
        return LedgerDirection.Debit;
      case WagerTransactionKind.OPENING:
      case WagerTransactionKind.WIN:
      case WagerTransactionKind.REFUND:
        return LedgerDirection.Credit;
      case WagerTransactionKind.LOSS:
        return null;
      case WagerTransactionKind.ROLLBACK:
        if (referenceKind === undefined) {
          throw new InvalidStateTransitionError(
            "ROLLBACK requires its reference to determine the ledger direction",
          );
        }
        return referenceKind === WagerTransactionKind.BET
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      default:
        throw new InvalidPayloadError("Unknown transaction kind");
    }
  }

  get currency(): string {
    return this.state.amount.currency;
  }

  markPendingReference(): void {
    this.assertPending();
    if (this.state.kind === WagerTransactionKind.OPENING) {
      throw new InvalidStateTransitionError(
        "OPENING transactions cannot wait for an external reference",
      );
    }
    this.statusValue = WagerTransactionStatus.PENDING_REFERENCE;
  }

  setReferenceTransactionId(id: string): void {
    this.assertPending();
    if (this.state.externalReferenceTransactionId === null) {
      throw new InvalidStateTransitionError(
        "A transaction without an external reference cannot have an internal reference",
      );
    }
    this.state.referenceTransactionId = wagerTransactionId(id);
  }

  markProcessed(at = new Date().toISOString()): void {
    this.assertPending();
    const processedAt = timestamp(at, "processedAt");
    this.statusValue = WagerTransactionStatus.PROCESSED;
    this.processedAtValue = processedAt;
    this.completedAtValue = processedAt;
  }

  reject(failureCode: FailureCode, at = new Date().toISOString()): void {
    this.completeWithFailure(WagerTransactionStatus.REJECTED, failureCode, at);
  }

  fail(failureCode: FailureCode, at = new Date().toISOString()): void {
    this.completeWithFailure(WagerTransactionStatus.FAILED, failureCode, at);
  }

  snapshot(): WagerTransactionSnapshot {
    return {
      id: this.state.id,
      providerId: this.state.providerId,
      playerId: this.state.playerId,
      walletId: this.state.walletId,
      financialOperationId: this.state.financialOperationId,
      externalTransactionId: this.state.externalTransactionId,
      idempotencyKey: this.state.idempotencyKey,
      payloadFingerprint: this.state.payloadFingerprint,
      externalReferenceTransactionId: this.state.externalReferenceTransactionId,
      referenceTransactionId: this.state.referenceTransactionId,
      roundId: this.state.roundId,
      gameId: this.state.gameId,
      kind: this.state.kind,
      status: this.statusValue,
      amount: this.state.amount.toDecimal(),
      currency: this.state.amount.currency,
      failureCode: this.failureCodeValue,
      createdAt: this.state.createdAt,
      processedAt: this.processedAtValue,
      completedAt: this.completedAtValue,
    };
  }

  private assertPending(): void {
    if (TERMINAL_STATUSES.has(this.statusValue)) {
      throw new InvalidStateTransitionError(
        `Cannot transition terminal status ${this.statusValue}`,
      );
    }
  }

  private completeWithFailure(
    status:
      | typeof WagerTransactionStatus.REJECTED
      | typeof WagerTransactionStatus.FAILED,
    failureCode: FailureCode,
    at: string,
  ): void {
    this.assertPending();
    if (!isFailureCode(failureCode)) {
      throw new InvalidPayloadError("Unknown failure code");
    }
    this.failureCodeValue = failureCode;
    const completedAt = timestamp(at, "completedAt");
    this.statusValue = status;
    this.completedAtValue = completedAt;
  }
}

/** WIN, LOSS and REFUND: the kinds that settle a BET. */
export const BET_RESULT_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.WIN,
  WagerTransactionKind.LOSS,
  WagerTransactionKind.REFUND,
]);

export function isBetResultKind(kind: WagerTransactionKind): boolean {
  return BET_RESULT_KINDS.has(kind);
}

/**
 * REFUND and ROLLBACK always reverse another operation, so they must name it.
 * WIN and LOSS may name the BET they settle; without one they are recorded on
 * their own (an uncorrelated credit, or a result with no movement).
 */
export function kindRequiresReference(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.REFUND ||
    kind === WagerTransactionKind.ROLLBACK
  );
}

/** Every external kind but BET may point at another transaction. */
export function kindAcceptsReference(kind: WagerTransactionKind): boolean {
  return isBetResultKind(kind) || kind === WagerTransactionKind.ROLLBACK;
}
