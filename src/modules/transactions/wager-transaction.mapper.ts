import { isRecord } from "../../shared/validation/index.js";
import {
  type FailureCode,
  InvalidPayloadError,
  isFailureCode,
  kindAcceptsReference,
  kindRequiresReference,
  Money,
  PayloadFingerprint,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionSnapshot,
  WagerTransactionStatus,
  type WalletSnapshot,
} from "../finance/domain/index.js";
import type { WagerTransactionRow } from "../finance/persistence/repositories.js";
import type {
  NormalizedWagerInput,
  ProcessWagerInput,
  WagerProcessingResponse,
  WagerProcessingResult,
} from "./types/index.js";

const EXTERNAL_KINDS = new Set<string>([
  WagerTransactionKind.BET,
  WagerTransactionKind.WIN,
  WagerTransactionKind.LOSS,
  WagerTransactionKind.REFUND,
  WagerTransactionKind.ROLLBACK,
]);

export function normalizeWagerInput(
  input: ProcessWagerInput,
): NormalizedWagerInput {
  if (!EXTERNAL_KINDS.has(input.kind)) {
    throw new InvalidPayloadError(
      "Unsupported external wager transaction kind",
    );
  }
  const amount = Money.fromDecimal(input.amount, input.currency);
  if (!amount.isPositive()) {
    throw new InvalidPayloadError(
      "Transaction amount must be greater than zero",
    );
  }

  const externalReferenceTransactionId = optionalText(
    input.externalReferenceTransactionId,
    "externalReferenceTransactionId",
  );
  // REFUND and ROLLBACK must name the operation they reverse; WIN and LOSS
  // may name the BET they settle; a BET names none. Checked here, before the
  // idempotency reservation, so a payload that can never be valid is refused
  // (400) instead of reserving a BET result.
  if (
    kindRequiresReference(input.kind) &&
    externalReferenceTransactionId === undefined
  ) {
    throw new InvalidPayloadError(
      `${input.kind} requires a transaction reference`,
    );
  }
  if (
    externalReferenceTransactionId !== undefined &&
    !kindAcceptsReference(input.kind)
  ) {
    throw new InvalidPayloadError(
      `${input.kind} cannot reference another transaction`,
    );
  }

  return {
    externalPlayerId: requiredText(
      input.externalPlayerId,
      "externalPlayerId",
      200,
    ),
    externalTransactionId: requiredText(
      input.externalTransactionId,
      "externalTransactionId",
      200,
    ),
    kind: input.kind,
    amount: amount.toDecimal(),
    currency: amount.currency,
    ...(externalReferenceTransactionId === undefined
      ? {}
      : { externalReferenceTransactionId }),
    ...(input.roundId === undefined
      ? {}
      : { roundId: requiredText(input.roundId, "roundId", 200) }),
    ...(input.gameId === undefined
      ? {}
      : { gameId: requiredText(input.gameId, "gameId", 200) }),
  };
}

/**
 * The fingerprint of a request, over an explicit field list rather than the
 * raw body: unknown fields must not change the digest, or a provider adding a
 * tracing field would see its retry refused as a payload conflict.
 *
 * Absent optional fields become `null` so that omitting one and sending it as
 * null are the same request. `PayloadFingerprint` sorts the keys, so the
 * digest does not depend on the order they are written here.
 */
export function hashWagerPayload(input: NormalizedWagerInput): string {
  return PayloadFingerprint.of({
    externalPlayerId: input.externalPlayerId,
    externalTransactionId: input.externalTransactionId,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    externalReferenceTransactionId:
      input.externalReferenceTransactionId ?? null,
    roundId: input.roundId ?? null,
    gameId: input.gameId ?? null,
  }).toString();
}

export function responseFromSnapshot(
  snapshot: unknown,
  httpStatus: number,
): WagerProcessingResult {
  if (!isRecord(snapshot) || !isWagerResponse(snapshot)) {
    throw new Error(
      "Persisted financial operation has an invalid response snapshot",
    );
  }

  return {
    httpStatus,
    idempotentReplay: true,
    response: {
      externalTransactionId: snapshot.externalTransactionId,
      status: snapshot.status,
      transaction: snapshot.transaction,
      wallet: snapshot.wallet,
      failureCode: snapshot.failureCode,
    },
  };
}

export function toWagerTransactionRow(
  snapshot: WagerTransactionSnapshot,
  nextReferenceAttemptAt: Date | null,
  referenceExpiresAt: Date | null,
  referenceAttempts = 0,
): Omit<WagerTransactionRow, "created_at"> {
  return {
    id: snapshot.id,
    provider_id: snapshot.providerId,
    player_id: snapshot.playerId,
    wallet_id: snapshot.walletId,
    financial_operation_id: snapshot.financialOperationId,
    external_transaction_id: snapshot.externalTransactionId,
    external_reference_transaction_id: snapshot.externalReferenceTransactionId,
    reference_transaction_id: snapshot.referenceTransactionId,
    round_id: snapshot.roundId,
    game_id: snapshot.gameId,
    kind: snapshot.kind,
    status: snapshot.status,
    amount: snapshot.amount,
    currency: snapshot.currency,
    failure_code: snapshot.failureCode,
    reference_attempts: referenceAttempts,
    next_reference_attempt_at: nextReferenceAttemptAt,
    reference_expires_at: referenceExpiresAt,
    processed_at:
      snapshot.processedAt === null ? null : new Date(snapshot.processedAt),
    completed_at:
      snapshot.completedAt === null ? null : new Date(snapshot.completedAt),
  };
}

/**
 * Rehydrates a persisted row into the aggregate, so domain rules never
 * receive a table shape. Row and aggregate stay convertible in both
 * directions, and this is the only place that knows the column names.
 */
export function wagerTransactionFromRow(
  row: WagerTransactionRow,
): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    financialOperationId: row.financial_operation_id,
    externalTransactionId: row.external_transaction_id,
    // Both live on the financial operation, not on this table.
    idempotencyKey: null,
    payloadFingerprint: null,
    externalReferenceTransactionId: row.external_reference_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    status: row.status as WagerTransactionStatus,
    amount: row.amount,
    currency: row.currency,
    failureCode: persistedFailureCode(row.failure_code),
    createdAt: new Date(row.created_at).toISOString(),
    processedAt:
      row.processed_at === null
        ? null
        : new Date(row.processed_at).toISOString(),
    completedAt:
      row.completed_at === null
        ? null
        : new Date(row.completed_at).toISOString(),
  });
}

function persistedFailureCode(value: string | null): FailureCode | null {
  if (value === null) {
    return null;
  }
  if (!isFailureCode(value)) {
    throw new Error(`Persisted failure code "${value}" is not recognized`);
  }
  return value;
}

export function isPendingWagerStatus(status: WagerTransactionStatus): boolean {
  return (
    status === WagerTransactionStatus.PENDING ||
    status === WagerTransactionStatus.PENDING_REFERENCE
  );
}

export function requiredText(
  value: string,
  field: string,
  maxLength: number,
): string {
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

function optionalText(
  value: string | undefined,
  field: string,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, 200);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isWagerTransactionSnapshot(
  value: unknown,
): value is WagerTransactionSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.providerId === "string" &&
    typeof value.playerId === "string" &&
    typeof value.walletId === "string" &&
    isNullableString(value.financialOperationId) &&
    isNullableString(value.externalTransactionId) &&
    isNullableString(value.idempotencyKey) &&
    isNullableString(value.payloadFingerprint) &&
    isNullableString(value.externalReferenceTransactionId) &&
    isNullableString(value.referenceTransactionId) &&
    isNullableString(value.roundId) &&
    isNullableString(value.gameId) &&
    Object.values(WagerTransactionKind).some((kind) => kind === value.kind) &&
    Object.values(WagerTransactionStatus).some(
      (status) => status === value.status,
    ) &&
    typeof value.amount === "string" &&
    typeof value.currency === "string" &&
    isNullableString(value.failureCode) &&
    typeof value.createdAt === "string" &&
    isNullableString(value.processedAt) &&
    isNullableString(value.completedAt)
  );
}

function isWalletSnapshot(value: unknown): value is WalletSnapshot {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.providerId === "string" &&
    typeof value.playerId === "string" &&
    typeof value.currency === "string" &&
    typeof value.balance === "string" &&
    typeof value.version === "number"
  );
}

function isWagerResponse(
  value: Record<string, unknown>,
): value is Record<string, unknown> & WagerProcessingResponse {
  return (
    typeof value.externalTransactionId === "string" &&
    Object.values(WagerTransactionStatus).some(
      (status) => status === value.status,
    ) &&
    (value.transaction === null ||
      isWagerTransactionSnapshot(value.transaction)) &&
    (value.wallet === null || isWalletSnapshot(value.wallet)) &&
    isNullableString(value.failureCode)
  );
}
