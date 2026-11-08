import { randomUUID } from "node:crypto";
import { currentCorrelationId } from "../../shared/observability/request-context.js";
import {
  eventContext,
  WagerTransactionPendingReference,
  WagerTransactionRejected,
} from "../events/integration-event.js";
import {
  type FailureCode,
  FinancialOperation,
  IdempotencyConflictError,
  PayloadFingerprint,
  type WagerTransaction,
  WagerTransactionStatus,
  type Wallet,
} from "../finance/domain/index.js";
import type {
  FinancialOperationRow,
  PersistenceSession,
  WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import type {
  WagerProcessingResponse,
  WagerProcessingResult,
} from "./types/index.js";
import {
  isPendingWagerStatus,
  responseFromSnapshot,
  toWagerTransactionRow,
} from "./wager-transaction.mapper.js";

const UNPROCESSABLE = 422;

/**
 * Claims the request identity, or decides what an already-claimed one gets.
 *
 * The `INSERT ... ON CONFLICT DO NOTHING` goes first on purpose: PostgreSQL,
 * not this process, arbitrates which concurrent request wins the key. Only
 * the loser reads the stored operation, and the domain entity then decides
 * between replaying, resuming and refusing.
 */
export async function reserveFinancialOperation(
  session: PersistenceSession,
  providerId: string,
  idempotencyKey: string,
  externalTransactionId: string,
  hash: string,
): Promise<
  | { readonly operation: FinancialOperationRow; readonly replay: null }
  | { readonly operation: null; readonly replay: WagerProcessingResult }
> {
  const operation = await session.financialOperations.reserve({
    id: randomUUID(),
    provider_id: providerId,
    idempotency_key: idempotencyKey,
    external_transaction_id: externalTransactionId,
    payload_hash: hash,
    response_snapshot: {
      externalTransactionId,
      status: WagerTransactionStatus.PENDING,
      transaction: null,
      wallet: null,
      failureCode: null,
    },
    response_http_status: 202,
    completed_at: null,
    correlation_id: currentCorrelationId(),
  });
  if (operation !== null) {
    return { operation, replay: null };
  }

  const byKey = await session.financialOperations.findByIdempotencyKey(
    providerId,
    idempotencyKey,
  );
  const byExternalId =
    await session.financialOperations.findByExternalTransactionId(
      providerId,
      externalTransactionId,
    );

  const decision = FinancialOperation.resolveReplay(
    {
      idempotencyKey,
      externalTransactionId,
      fingerprint: PayloadFingerprint.fromDigest(hash),
    },
    byKey === null ? null : financialOperationFromRow(byKey),
    byExternalId === null ? null : financialOperationFromRow(byExternalId),
  );
  if (decision === null) {
    throw new Error(
      "Financial operation reservation conflicted without a matching identity",
    );
  }

  if (decision.kind === "conflict") {
    throw new IdempotencyConflictError(
      idempotencyKey,
      decision.storedDigest,
      hash,
    );
  }

  const row = byKey?.id === decision.operation.id ? byKey : byExternalId;
  if (row === null || row === undefined) {
    throw new Error("Financial operation identity disappeared during replay");
  }

  if (decision.kind === "resume") {
    return { operation: row, replay: null };
  }

  return {
    operation: null,
    replay: responseFromSnapshot(
      row.response_snapshot,
      row.response_http_status,
    ),
  };
}

/** The only place that maps an operation row onto its aggregate. */
export function financialOperationFromRow(
  row: FinancialOperationRow,
): FinancialOperation {
  return FinancialOperation.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    idempotencyKey: row.idempotency_key,
    externalTransactionId: row.external_transaction_id,
    payloadHash: row.payload_hash,
    responseSnapshot: row.response_snapshot,
    responseHttpStatus: row.response_http_status,
    completedAt: row.completed_at,
  });
}

/**
 * Rejects a request refused before any wager transaction exists (unknown
 * player or wallet, inactive provider, caller-supplied rejection).
 */
export async function rejectWithoutTransaction(
  session: PersistenceSession,
  operation: FinancialOperationRow,
  externalTransactionId: string,
  failureCode: string,
): Promise<WagerProcessingResult> {
  const httpStatus = UNPROCESSABLE;
  const response: WagerProcessingResponse = {
    externalTransactionId,
    status: WagerTransactionStatus.REJECTED,
    transaction: null,
    wallet: null,
    failureCode,
  };

  // No transaction exists yet, so the operation is the aggregate this
  // rejection belongs to. It still has to be published: an auditable refusal
  // is part of the contract.
  await session.outbox.create(
    WagerTransactionRejected.from(
      operation.id,
      {
        financialOperationId: operation.id,
        providerId: operation.provider_id,
        externalTransactionId,
        failureCode,
      },
      eventContext(),
    ).toOutboxRow(),
  );
  await completeFinancialOperation(
    session,
    operation.id,
    response,
    httpStatus,
    new Date(),
  );

  return { httpStatus, idempotentReplay: false, response };
}

export async function rejectPendingWager(
  session: PersistenceSession,
  operation: FinancialOperationRow,
  pending: WagerTransactionRow,
  externalTransactionId: string,
  failureCode: string,
): Promise<WagerProcessingResult> {
  const httpStatus = UNPROCESSABLE;
  const completedAt = new Date();
  const updated = await session.wagerTransactions.update({
    id: pending.id,
    status: WagerTransactionStatus.REJECTED,
    reference_transaction_id: pending.reference_transaction_id,
    failure_code: failureCode,
    reference_attempts: pending.reference_attempts + 1,
    next_reference_attempt_at: null,
    reference_expires_at: pending.reference_expires_at,
    processed_at: null,
    completed_at: completedAt,
  });
  if (updated === null) {
    throw new Error("Pending wager disappeared before rejection");
  }

  const response: WagerProcessingResponse = {
    externalTransactionId,
    status: WagerTransactionStatus.REJECTED,
    transaction: null,
    wallet: null,
    failureCode,
  };
  await session.outbox.create(
    WagerTransactionRejected.from(
      pending.id,
      {
        wagerTransactionId: pending.id,
        providerId: operation.provider_id,
        externalTransactionId,
        failureCode,
      },
      eventContext(),
    ).toOutboxRow(),
  );
  await completeFinancialOperation(
    session,
    operation.id,
    response,
    httpStatus,
    completedAt,
  );

  return { httpStatus, idempotentReplay: false, response };
}

/** Rejects the wager on its aggregate and persists that final result. */
export function rejectWager(
  session: PersistenceSession,
  operation: FinancialOperationRow,
  wager: WagerTransaction,
  wallet: Wallet,
  failureCode: FailureCode,
): Promise<WagerProcessingResult> {
  wager.reject(failureCode);
  return persistWagerResult(
    session,
    operation,
    wager,
    wallet,
    UNPROCESSABLE,
    null,
    null,
  );
}

export async function persistWagerResult(
  session: PersistenceSession,
  operation: FinancialOperationRow,
  wager: WagerTransaction,
  wallet: Wallet,
  httpStatus: number,
  nextReferenceAttemptAt: Date | null,
  referenceExpiresAt: Date | null,
): Promise<WagerProcessingResult> {
  const snapshot = wager.snapshot();
  const externalTransactionId = snapshot.externalTransactionId;
  if (externalTransactionId === null) {
    throw new Error(
      "External wager transactions require an external transaction ID",
    );
  }

  const existing = await session.wagerTransactions.findByIdForUpdate(wager.id);
  const referenceAttempts =
    existing?.status === WagerTransactionStatus.PENDING_REFERENCE
      ? existing.reference_attempts + 1
      : (existing?.reference_attempts ?? 0);
  const persistedTransaction = toWagerTransactionRow(
    snapshot,
    nextReferenceAttemptAt,
    referenceExpiresAt,
    referenceAttempts,
  );
  if (existing === null) {
    await session.wagerTransactions.create(persistedTransaction);
  } else {
    const updated = await session.wagerTransactions.update({
      id: persistedTransaction.id,
      status: persistedTransaction.status,
      reference_transaction_id: persistedTransaction.reference_transaction_id,
      failure_code: persistedTransaction.failure_code,
      reference_attempts: persistedTransaction.reference_attempts,
      next_reference_attempt_at: persistedTransaction.next_reference_attempt_at,
      reference_expires_at: persistedTransaction.reference_expires_at,
      processed_at: persistedTransaction.processed_at,
      completed_at: persistedTransaction.completed_at,
    });
    if (updated === null) {
      throw new Error("Wager transaction disappeared during pending retry");
    }
  }

  const response: WagerProcessingResponse = {
    externalTransactionId,
    status: snapshot.status,
    transaction: snapshot,
    wallet: wallet.snapshot(),
    failureCode: snapshot.failureCode,
  };
  if (snapshot.status === WagerTransactionStatus.REJECTED) {
    await session.outbox.create(
      WagerTransactionRejected.from(
        wager.id,
        {
          wagerTransactionId: wager.id,
          providerId: snapshot.providerId,
          externalTransactionId,
          kind: snapshot.kind,
          money: { amount: snapshot.amount, currency: snapshot.currency },
          failureCode: requiredFailureCode(snapshot.failureCode),
        },
        eventContext(),
      ).toOutboxRow(),
    );
  } else if (
    snapshot.status === WagerTransactionStatus.PENDING_REFERENCE &&
    existing === null
  ) {
    await session.outbox.create(
      WagerTransactionPendingReference.from(
        {
          wagerTransactionId: wager.id,
          providerId: snapshot.providerId,
          externalReferenceTransactionId:
            snapshot.externalReferenceTransactionId,
        },
        eventContext(),
      ).toOutboxRow(),
    );
  }

  await completeFinancialOperation(
    session,
    operation.id,
    response,
    httpStatus,
    isPendingWagerStatus(snapshot.status) ? null : new Date(),
  );

  return { httpStatus, idempotentReplay: false, response };
}

export async function completeFinancialOperation(
  session: PersistenceSession,
  operationId: string,
  response: WagerProcessingResponse,
  httpStatus: number,
  completedAt: Date | null,
): Promise<void> {
  const updated = await session.financialOperations.complete(
    operationId,
    response,
    httpStatus,
    completedAt,
  );
  if (updated === null) {
    throw new Error(
      "Reserved financial operation disappeared before completion",
    );
  }
}

/**
 * A rejection event must name its reason. A rejected transaction without a
 * failure code is a corrupted record, not a publishable event.
 */
function requiredFailureCode(value: string | null): string {
  if (value === null) {
    throw new Error("A rejected wager transaction must carry a failure code");
  }
  return value;
}
