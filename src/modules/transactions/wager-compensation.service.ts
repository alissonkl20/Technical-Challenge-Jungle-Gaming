import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { compensationSettings } from "../../config/settings.js";
import { errorMessage } from "../../shared/errors/error-chain.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import { exponentialBackoff } from "../../shared/retry/exponential-backoff.js";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../finance/domain/index.js";
import {
  type PersistenceSession,
  type TransactionManager,
  type WagerRecoveryRow,
  WagerRecoveryStatus,
  type WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import type {
  CompensationBatchResult,
  WagerProcessingResult,
} from "./types/index.js";
import { WagerTransactionsService } from "./wager-transactions.service.js";

const MAX_DELAY_MS = 3_600_000;
const MAX_ERROR_LENGTH = 2_000;

/**
 * Neutralizes a committed wager whose post-commit work (publishing its
 * financial events) failed past the recovery limit.
 *
 * The compensation is a new financial operation, never an edit of the
 * original: a ROLLBACK of the original wager, submitted through the same use
 * case as every other operation, so it gets the same locks, Ledger entry,
 * reversal rules and idempotency. It is applied and the recovery is marked
 * COMPENSATED in ONE SQL transaction, so "compensated" is never recorded
 * without the money having moved, and a retry after a crash finds either
 * nothing done or everything done.
 *
 * Double compensation is prevented three times over: the recovery row is
 * locked (SKIP LOCKED across instances) and re-read; the compensation has a
 * fixed idempotency key and external ID; and PostgreSQL allows one processed
 * reversal per transaction.
 */
@Injectable()
export class WagerCompensationService {
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(WagerTransactionsService)
    private readonly wagers: WagerTransactionsService,
    @Optional()
    @Inject(ConfigService)
    configuration?: ConfigService,
    @Optional()
    @Inject(JsonLogger)
    private readonly logger?: JsonLogger,
  ) {
    const settings = compensationSettings(configuration);
    this.maxAttempts = settings.maxAttempts;
    this.baseDelayMs = settings.retryBaseDelayMs;
  }

  async compensateDue(limit: number): Promise<CompensationBatchResult> {
    const due = await this.transactions.transaction((session) =>
      session.recoveries.findDueForCompensation(limit),
    );
    const resolved: Record<string, number> = {};
    let deferred = 0;

    for (const recovery of due) {
      try {
        const status = await this.compensate(recovery.id);
        if (status !== null) {
          resolved[status] = (resolved[status] ?? 0) + 1;
        }
      } catch (error) {
        deferred += 1;
        await this.defer(recovery, error);
      }
    }
    return { examined: due.length, resolved, deferred };
  }

  /**
   * Compensates one recovery. Returns the terminal status written, or null
   * when another instance holds or already resolved it.
   */
  compensate(recoveryId: string): Promise<WagerRecoveryStatus | null> {
    return this.transactions.transaction(async (session) => {
      const recovery =
        await session.recoveries.findByIdForUpdateSkipLocked(recoveryId);
      if (
        recovery === null ||
        recovery.status !== WagerRecoveryStatus.COMPENSATION_REQUIRED
      ) {
        return null;
      }
      const original = await session.wagerTransactions.findById(
        recovery.wager_transaction_id,
      );
      if (
        original === null ||
        original.status !== WagerTransactionStatus.PROCESSED
      ) {
        throw new Error(
          `Recovery ${recovery.id} points at a wager that is not processed`,
        );
      }

      if (original.kind === WagerTransactionKind.LOSS) {
        // A LOSS moved no money: there is nothing to neutralize.
        return this.finish(
          session,
          recovery,
          WagerRecoveryStatus.COMPENSATION_NOT_REQUIRED,
          null,
          "NO_FINANCIAL_EFFECT",
        );
      }

      const result = await this.submitRollback(session, recovery, original);
      return this.recordOutcome(session, recovery, result);
    });
  }

  /**
   * Submits a ROLLBACK of the original through the wager use case, inside the
   * caller's transaction, under the correlation of the original operation.
   */
  private async submitRollback(
    session: PersistenceSession,
    recovery: WagerRecoveryRow,
    original: WagerTransactionRow,
  ): Promise<WagerProcessingResult> {
    const player = await session.players.findById(original.player_id);
    if (player === null || original.external_transaction_id === null) {
      throw new Error(`Recovery ${recovery.id} has no external context`);
    }
    const originalExternalId = original.external_transaction_id;
    const identity = compensationIdentity(original);
    const operation = original.financial_operation_id
      ? await session.financialOperations.findById(
          original.financial_operation_id,
        )
      : null;

    return withCorrelationId(
      operation?.correlation_id ?? undefined,
      () =>
        this.wagers.process(
          original.provider_id,
          identity.idempotencyKey,
          {
            externalPlayerId: player.external_player_id,
            externalTransactionId: identity.externalTransactionId,
            kind: WagerTransactionKind.ROLLBACK,
            amount: original.amount,
            currency: original.currency,
            externalReferenceTransactionId: originalExternalId,
            ...(original.round_id === null
              ? {}
              : { roundId: original.round_id }),
            ...(original.game_id === null ? {} : { gameId: original.game_id }),
          },
          session,
        ),
      recovery.id,
    );
  }

  private recordOutcome(
    session: PersistenceSession,
    recovery: WagerRecoveryRow,
    result: WagerProcessingResult,
  ): Promise<WagerRecoveryStatus> {
    const response = result.response;
    if (response.status === WagerTransactionStatus.PROCESSED) {
      const compensationId = response.transaction?.id;
      if (compensationId === undefined) {
        throw new Error("Processed compensation returned no transaction");
      }
      return this.finish(
        session,
        recovery,
        WagerRecoveryStatus.COMPENSATED,
        compensationId,
        null,
      );
    }
    if (response.failureCode === FailureCode.ReferenceAlreadyReversed) {
      // The provider (or an operator) already reversed the wager: its
      // effect is neutralized, and reversing it again would credit twice.
      return this.finish(
        session,
        recovery,
        WagerRecoveryStatus.COMPENSATION_NOT_REQUIRED,
        null,
        response.failureCode,
      );
    }
    // A business rule refused the compensation, e.g. a WIN whose prize was
    // already spent (REVERSAL_INSUFFICIENT_FUNDS). The refusal is recorded
    // as a rejected ROLLBACK and needs an operator.
    return this.finish(
      session,
      recovery,
      WagerRecoveryStatus.COMPENSATION_REJECTED,
      null,
      response.failureCode ?? "UNKNOWN",
    );
  }

  private async finish(
    session: PersistenceSession,
    recovery: WagerRecoveryRow,
    status: WagerRecoveryStatus,
    compensationTransactionId: string | null,
    failureCode: string | null,
  ): Promise<WagerRecoveryStatus> {
    await session.recoveries.resolve(
      recovery.id,
      status,
      compensationTransactionId,
      failureCode,
    );
    this.logger?.emit(
      status === WagerRecoveryStatus.COMPENSATED ? "warn" : "error",
      "wager.compensation.resolved",
      {
        transactionId: recovery.wager_transaction_id,
        walletId: recovery.wallet_id,
        providerId: recovery.provider_id,
        status,
        ...(failureCode === null ? {} : { errorCode: failureCode }),
      },
    );
    return status;
  }

  private async defer(
    recovery: WagerRecoveryRow,
    error: unknown,
  ): Promise<void> {
    const attempt = recovery.compensation_attempts + 1;
    const exhausted = attempt >= this.maxAttempts;
    const delay = exponentialBackoff(this.baseDelayMs, attempt - 1, {
      maxExponent: 20,
      maxDelay: MAX_DELAY_MS,
    });
    const message = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
    try {
      await this.transactions.transaction((session) =>
        session.recoveries.deferCompensation(
          recovery.id,
          delay,
          message,
          exhausted,
        ),
      );
    } finally {
      this.logger?.emit("error", "wager.compensation.failed", {
        transactionId: recovery.wager_transaction_id,
        walletId: recovery.wallet_id,
        providerId: recovery.provider_id,
        errorCode: exhausted ? "COMPENSATION_EXHAUSTED" : "COMPENSATION_RETRY",
        attempts: attempt,
      });
    }
  }
}

/** External identity of the compensation of a wager, stable across retries. */
function compensationIdentity(original: WagerTransactionRow): {
  readonly idempotencyKey: string;
  readonly externalTransactionId: string;
} {
  return {
    idempotencyKey: `compensation:${original.id}`,
    externalTransactionId: `compensation:${original.external_transaction_id ?? original.id}`,
  };
}
