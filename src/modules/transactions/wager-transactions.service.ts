import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type PendingReferenceSettings,
  pendingReferenceSettings,
} from "../../config/settings.js";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { providerFromRow } from "../finance/application/domain-row.mapper.js";
import {
  FailureCode,
  IdempotencyConflictError,
  PlayerStatus,
  type Provider,
  ProviderNotFoundError,
  ProviderStatus,
  providerId as validateProviderId,
  type WagerTransaction,
  WagerTransactionStatus,
  type Wallet,
} from "../finance/domain/index.js";
import type {
  FinancialOperationRow,
  PersistenceSession,
  TransactionManager,
  WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import {
  pendingReferenceExpiry,
  pendingReferenceRetryDelayMs,
} from "./pending-reference.schedule.js";
import type {
  ProcessWagerInput,
  WagerProcessingResult,
  WagerRequest,
} from "./types/index.js";
import { loadWagerContext } from "./wager-context.js";
import { applyWagerMovement } from "./wager-financial-movement.js";
import {
  persistWagerResult,
  rejectPendingWager,
  rejectWager,
  rejectWithoutTransaction,
  reserveFinancialOperation,
} from "./wager-operation.persistence.js";
import { persistProcessedWager } from "./wager-processed.persistence.js";
import { resolveAndValidateWagerReference } from "./wager-reference.rules.js";
import { createOrRehydrateWager } from "./wager-transaction.factory.js";
import {
  hashWagerPayload,
  normalizeWagerInput,
  requiredText,
  responseFromSnapshot,
} from "./wager-transaction.mapper.js";

const ACCEPTED = 202;
const UNPROCESSABLE = 422;

/**
 * Whether the result answered an earlier identical request. It is shared
 * across the retries of one call, so a retried transaction keeps the flag.
 */
interface ReplayTracking {
  replay: boolean;
}

/**
 * The single financial use case: every channel (HTTP, SQS, pending-reference
 * worker, compensation) submits wagers through `process`.
 */
@Injectable()
export class WagerTransactionsService {
  private readonly pendingReferences: PendingReferenceSettings;

  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(ConfigService)
    configuration?: ConfigService,
    @Optional()
    @Inject(FinancialMetrics)
    private readonly metrics?: FinancialMetrics,
    @Optional()
    @Inject(JsonLogger)
    private readonly structuredLogger?: JsonLogger,
  ) {
    this.pendingReferences = pendingReferenceSettings(configuration);
  }

  /**
   * Processes one wager in one SQL transaction, or inside the caller's
   * `persistenceSession` when the caller must commit other work atomically
   * with it (Inbox record, compensation status). Invalid input throws
   * synchronously, before any transaction starts.
   */
  process(
    providerId: string,
    idempotencyKey: string,
    input: ProcessWagerInput,
    persistenceSession?: PersistenceSession,
  ): Promise<WagerProcessingResult> {
    const request = normalizeRequest(providerId, idempotencyKey, input);
    const startedAt = performance.now();
    const tracking: ReplayTracking = { replay: false };

    const execute = (session: PersistenceSession) =>
      this.execute(session, request, tracking);
    const processing = persistenceSession
      ? execute(persistenceSession)
      : this.transactions.transaction(execute);

    return this.observe(processing, request.providerId, startedAt, tracking);
  }

  private async execute(
    session: PersistenceSession,
    request: WagerRequest,
    tracking: ReplayTracking,
  ): Promise<WagerProcessingResult> {
    const provider = await lockProvider(session, request.providerId);
    const reservation = await reserveFinancialOperation(
      session,
      provider.id,
      request.idempotencyKey,
      request.input.externalTransactionId,
      request.payloadHash,
    );
    if (reservation.replay !== null) {
      tracking.replay = true;
      this.metrics?.recordDuplicate("replay");
      return reservation.replay;
    }

    const operation = reservation.operation;
    if (request.preRejection !== undefined) {
      return rejectWithoutTransaction(
        session,
        operation,
        request.input.externalTransactionId,
        request.preRejection,
      );
    }
    if (provider.status !== ProviderStatus.ACTIVE) {
      return this.rejectForInactiveProvider(
        session,
        provider,
        operation,
        request,
        tracking,
      );
    }
    return this.settle(session, provider, operation, request, tracking);
  }

  private async rejectForInactiveProvider(
    session: PersistenceSession,
    provider: Provider,
    operation: FinancialOperationRow,
    request: WagerRequest,
    tracking: ReplayTracking,
  ): Promise<WagerProcessingResult> {
    const { externalTransactionId } = request.input;
    // This path takes only the pending row, and nothing is awaited after it,
    // so it cannot form a lock cycle with a settlement.
    const existingPending =
      await session.wagerTransactions.findByProviderAndExternalTransactionIdForUpdate(
        provider.id,
        externalTransactionId,
      );
    const replayed = await this.replayIfCompleted(
      session,
      operation,
      existingPending,
      tracking,
    );
    if (replayed !== null) {
      return replayed;
    }
    if (existingPending !== null) {
      return rejectPendingWager(
        session,
        operation,
        existingPending,
        externalTransactionId,
        FailureCode.ProviderInactive,
      );
    }
    return rejectWithoutTransaction(
      session,
      operation,
      externalTransactionId,
      FailureCode.ProviderInactive,
    );
  }

  private async settle(
    session: PersistenceSession,
    provider: Provider,
    operation: FinancialOperationRow,
    request: WagerRequest,
    tracking: ReplayTracking,
  ): Promise<WagerProcessingResult> {
    const { input } = request;
    // Lock order, shared by every path that settles money:
    //   provider (share) -> player (share) -> wallet (update)
    //   -> transaction rows (pending, then references).
    // The wallet is locked before any transaction row, so no two paths can
    // hold a row and wait for the wallet in the opposite order.
    const context = await loadWagerContext(
      session,
      provider,
      input.externalPlayerId,
      input.currency,
    );
    if (context.kind === "player-not-found") {
      return rejectWithoutTransaction(
        session,
        operation,
        input.externalTransactionId,
        FailureCode.PlayerNotFound,
      );
    }
    if (context.kind === "wallet-not-found") {
      return rejectWithoutTransaction(
        session,
        operation,
        input.externalTransactionId,
        FailureCode.WalletNotFound,
      );
    }
    const { playerRow, player, walletRow, wallet } = context;

    const existingPending =
      await session.wagerTransactions.findByProviderAndExternalTransactionIdForUpdate(
        provider.id,
        input.externalTransactionId,
      );
    const replayed = await this.replayIfCompleted(
      session,
      operation,
      existingPending,
      tracking,
    );
    if (replayed !== null) {
      return replayed;
    }

    const wager = createOrRehydrateWager({
      provider,
      player,
      wallet,
      operation,
      input,
      payloadHash: request.payloadHash,
      existingPending,
    });
    const referenceAttempts = existingPending?.reference_attempts ?? 0;
    // Expiry is only evaluated after the reference is resolved below: a
    // reference that arrived in time must still be honored.
    const referenceExpired = isReferenceExpired(existingPending);

    if (player.status !== PlayerStatus.ACTIVE) {
      return rejectWager(
        session,
        operation,
        wager,
        wallet,
        FailureCode.PlayerInactive,
      );
    }

    const reference = await resolveAndValidateWagerReference(
      session,
      provider.id,
      wallet,
      wager,
      input,
    );
    if (reference.kind === "pending") {
      return this.awaitReference(
        session,
        operation,
        wager,
        wallet,
        existingPending,
        referenceExpired,
        referenceAttempts,
      );
    }
    if (reference.kind === "rejected") {
      return rejectWager(
        session,
        operation,
        wager,
        wallet,
        reference.failureCode,
      );
    }

    const outcome = applyWagerMovement(
      wager,
      wallet,
      reference.transaction?.kind as ProcessWagerInput["kind"] | undefined,
    );
    if (outcome.failureCode !== null) {
      return rejectWager(
        session,
        operation,
        wager,
        wallet,
        outcome.failureCode,
      );
    }

    return persistProcessedWager({
      session,
      operation,
      player: playerRow,
      walletRow,
      wallet,
      wager,
      externalTransactionId: input.externalTransactionId,
      movement: outcome.movement,
      existingPending,
      referenceAttempts,
    });
  }

  /**
   * The referenced transaction has not arrived. Past the TTL the wager is
   * rejected; otherwise it waits as PENDING_REFERENCE with exponential
   * backoff, keeping the expiry set when it first started waiting.
   */
  private awaitReference(
    session: PersistenceSession,
    operation: FinancialOperationRow,
    wager: WagerTransaction,
    wallet: Wallet,
    existingPending: WagerTransactionRow | null,
    referenceExpired: boolean,
    referenceAttempts: number,
  ): Promise<WagerProcessingResult> {
    if (referenceExpired) {
      wager.reject(FailureCode.ReferenceNotFound);
      return persistWagerResult(
        session,
        operation,
        wager,
        wallet,
        UNPROCESSABLE,
        null,
        existingPending?.reference_expires_at ?? null,
      );
    }
    wager.markPendingReference();
    const now = new Date();
    const retryDelay = pendingReferenceRetryDelayMs(
      this.pendingReferences.initialDelayMs,
      referenceAttempts,
    );
    const nextAttempt = new Date(now.getTime() + retryDelay);
    const expiresAt =
      existingPending?.reference_expires_at ??
      pendingReferenceExpiry(now, this.pendingReferences.ttlHours);
    return persistWagerResult(
      session,
      operation,
      wager,
      wallet,
      ACCEPTED,
      nextAttempt,
      expiresAt,
    );
  }

  /**
   * A completed operation is answered from its stored snapshot; a pending one
   * that is still waiting for its reference is resumed instead (null).
   */
  private async replayIfCompleted(
    session: PersistenceSession,
    operation: FinancialOperationRow,
    existingPending: WagerTransactionRow | null,
    tracking: ReplayTracking,
  ): Promise<WagerProcessingResult | null> {
    if (
      existingPending === null ||
      existingPending.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      return null;
    }
    const latestOperation = await session.financialOperations.findById(
      operation.id,
    );
    if (latestOperation === null) {
      throw new Error("Financial operation disappeared during reference retry");
    }
    tracking.replay = true;
    return responseFromSnapshot(
      latestOperation.response_snapshot,
      latestOperation.response_http_status,
    );
  }

  private observe(
    processing: Promise<WagerProcessingResult>,
    providerId: string,
    startedAt: number,
    tracking: ReplayTracking,
  ): Promise<WagerProcessingResult> {
    return processing
      .then((result) => {
        if (!tracking.replay) {
          this.metrics?.recordTransactionStatus(result.response.status);
        }
        this.structuredLogger?.emit("log", "financial.wager.processed", {
          providerId,
          transactionId: result.response.transaction?.id ?? null,
          walletId: result.response.wallet?.id ?? null,
          status: result.response.status,
        });
        return result;
      })
      .catch((error: unknown) => {
        if (error instanceof IdempotencyConflictError) {
          this.metrics?.recordDuplicate("conflict");
        }
        throw error;
      })
      .finally(() => {
        this.metrics?.observeProcessingDuration(performance.now() - startedAt);
      });
  }
}

/** Validates and canonicalizes a request; throws before any transaction. */
function normalizeRequest(
  providerId: string,
  idempotencyKey: string,
  input: ProcessWagerInput,
): WagerRequest {
  const normalizedProviderId = validateProviderId(providerId);
  const normalizedKey = requiredText(idempotencyKey, "idempotencyKey", 200);
  const normalizedInput = normalizeWagerInput(input);
  return {
    providerId: normalizedProviderId,
    idempotencyKey: normalizedKey,
    input: normalizedInput,
    payloadHash: hashWagerPayload(normalizedInput),
    ...(input.rejection === undefined ? {} : { preRejection: input.rejection }),
  };
}

/** Locks the provider row (share): the first lock of every settlement. */
async function lockProvider(
  session: PersistenceSession,
  providerId: string,
): Promise<Provider> {
  const providerRow = await session.providers.findByIdForShare(providerId);
  if (providerRow === null) {
    throw new ProviderNotFoundError("Provider context was not found");
  }
  return providerFromRow(providerRow);
}

function isReferenceExpired(pending: WagerTransactionRow | null): boolean {
  return (
    pending?.reference_expires_at !== null &&
    pending?.reference_expires_at !== undefined &&
    new Date(pending.reference_expires_at).getTime() <= Date.now()
  );
}
