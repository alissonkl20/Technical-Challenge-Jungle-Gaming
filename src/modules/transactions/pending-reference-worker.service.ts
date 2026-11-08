import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  type PendingReferenceSettings,
  pendingReferenceSettings,
} from "../../config/settings.js";
import { errorCodeOf, errorMessage } from "../../shared/errors/error-chain.js";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import {
  FailureCode,
  WagerTransactionStatus,
} from "../finance/domain/index.js";
import type {
  TransactionManager,
  WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import { PermanentReferenceError } from "./errors/index.js";
import { pendingReferenceRetryDelayMs } from "./pending-reference.schedule.js";
import { PendingReferenceRetryService } from "./pending-reference-retry.service.js";
import type { PendingReferenceBatchResult } from "./types/index.js";

interface BatchTally {
  completed: number;
  retried: number;
  failed: number;
  readonly failures: string[];
}

@Injectable()
export class PendingReferenceWorkerService {
  private readonly logger = new Logger(PendingReferenceWorkerService.name);
  private readonly settings: PendingReferenceSettings;

  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(PendingReferenceRetryService)
    private readonly pendingReferences: PendingReferenceRetryService,
    @Inject(ConfigService)
    configuration: ConfigService,
    @Optional()
    @Inject(FinancialMetrics)
    private readonly metrics?: FinancialMetrics,
    @Optional()
    @Inject(JsonLogger)
    private readonly structuredLogger?: JsonLogger,
  ) {
    this.settings = pendingReferenceSettings(configuration);
  }

  async processDue(limit: number): Promise<PendingReferenceBatchResult> {
    const pending = await this.transactions.transaction((session) =>
      session.wagerTransactions.findDuePendingReferences(limit),
    );
    const tally: BatchTally = {
      completed: 0,
      retried: 0,
      failed: 0,
      failures: [],
    };

    for (const transaction of pending) {
      // The pending transaction is the cause of this retry. Its correlation
      // comes from the stored operation, inside the retry service.
      await withCorrelationId(
        undefined,
        () => this.retryOne(transaction, tally),
        transaction.id,
      );
    }

    const open = await this.transactions.transaction((session) =>
      session.wagerTransactions.countPendingReferences(),
    );
    this.metrics?.setPendingReferenceCount(open);

    return { examined: pending.length, ...tally };
  }

  private async retryOne(
    transaction: WagerTransactionRow,
    tally: BatchTally,
  ): Promise<void> {
    try {
      const result = await this.pendingReferences.retry(transaction.id);
      if (
        result?.response.status === WagerTransactionStatus.PENDING_REFERENCE
      ) {
        tally.retried += 1;
      } else {
        tally.completed += 1;
      }
    } catch (error) {
      if (error instanceof PermanentReferenceError) {
        await this.handlePermanentFailure(transaction, error, tally);
      } else {
        await this.handleTransientFailure(transaction, error, tally);
      }
    }
  }

  /**
   * Retrying cannot change this outcome, so the transaction ends in an
   * auditable FAILED state instead of looping until its TTL.
   */
  private async handlePermanentFailure(
    transaction: WagerTransactionRow,
    error: PermanentReferenceError,
    tally: BatchTally,
  ): Promise<void> {
    if (await this.failPermanently(transaction.id)) {
      tally.failed += 1;
    }
    tally.failures.push(`${transaction.id}: ${error.message}`);
    this.structuredLogger?.emit("error", "pending_reference.failed", {
      transactionId: transaction.id,
      walletId: transaction.wallet_id,
      providerId: transaction.provider_id,
      errorCode: FailureCode.InternalInconsistency,
    });
  }

  /** Infrastructure failure: postpone the next attempt with backoff. */
  private async handleTransientFailure(
    transaction: WagerTransactionRow,
    error: unknown,
    tally: BatchTally,
  ): Promise<void> {
    tally.failures.push(`${transaction.id}: ${errorMessage(error)}`);
    const retryDelay = pendingReferenceRetryDelayMs(
      this.settings.initialDelayMs,
      transaction.reference_attempts,
    );
    this.metrics?.recordRetry("pending_reference");
    try {
      await this.transactions.transaction((session) =>
        session.wagerTransactions.deferPendingReference(
          transaction.id,
          retryDelay,
        ),
      );
    } catch {
      this.logger.error(
        `Failed to reschedule pending reference ${transaction.id}`,
      );
    }
    this.structuredLogger?.emit("error", "pending_reference.retry.failed", {
      transactionId: transaction.id,
      walletId: transaction.wallet_id,
      providerId: transaction.provider_id,
      errorCode: errorCodeOf(error),
    });
    this.logger.error(`Pending reference retry failed for ${transaction.id}`);
  }

  /**
   * Moves a pending transaction to FAILED and completes its operation with that
   * final response. Runs under a row lock, so a concurrent resume that already
   * settled the transaction wins and nothing is overwritten.
   */
  private async failPermanently(transactionId: string): Promise<boolean> {
    return this.transactions.transaction(async (session) => {
      const row =
        await session.wagerTransactions.findByIdForUpdate(transactionId);
      if (
        row === null ||
        row.status !== WagerTransactionStatus.PENDING_REFERENCE
      ) {
        return false;
      }
      const completedAt = new Date();
      await session.wagerTransactions.update({
        id: row.id,
        status: WagerTransactionStatus.FAILED,
        reference_transaction_id: row.reference_transaction_id,
        failure_code: FailureCode.InternalInconsistency,
        reference_attempts: row.reference_attempts + 1,
        next_reference_attempt_at: null,
        reference_expires_at: row.reference_expires_at,
        processed_at: null,
        completed_at: completedAt,
      });
      if (row.financial_operation_id !== null) {
        await session.financialOperations.complete(
          row.financial_operation_id,
          {
            externalTransactionId: row.external_transaction_id,
            status: WagerTransactionStatus.FAILED,
            transaction: null,
            wallet: null,
            failureCode: FailureCode.InternalInconsistency,
          },
          500,
          completedAt,
        );
      }
      return true;
    });
  }
}
