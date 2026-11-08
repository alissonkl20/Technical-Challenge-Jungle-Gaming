import { Inject, Injectable, Optional } from "@nestjs/common";
import { FinancialMetrics } from "../../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../../shared/observability/json-logger.js";
import {
  FinancialOperationNotFoundError,
  WagerTransactionNotFoundError,
  WalletNotFoundError,
} from "../domain/errors.js";
import { Money, WagerTransactionStatus } from "../domain/index.js";
import type {
  PersistenceSession,
  TransactionManager,
  WalletLedgerRow,
} from "../persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../persistence/tokens.js";
import {
  isoTimestamp,
  ledgerCursorAfter,
  ledgerEntryView,
  nullableIsoTimestamp,
  wagerTransactionView,
  walletView,
} from "./read-model.mapper.js";
import type {
  ExternalTransactionLookupView,
  LedgerCursor,
  LedgerPageView,
  OperationStatusView,
  QueryScope,
  ReconciliationView,
  WagerTransactionView,
  WalletLedgerPageView,
  WalletView,
} from "./types/index.js";

/**
 * The read side of the finance module.
 *
 * It lives here rather than beside the controllers because it is the only
 * layer allowed to touch persistence. Readers receive views; no caller outside
 * this module names a column, so the published response shapes do not move
 * when the schema does.
 *
 * Every query scopes by `provider_id` as well as by the requested identifier,
 * so one provider cannot read another's wallet by guessing a UUID.
 */
@Injectable()
export class FinanceQueriesService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Optional()
    @Inject(FinancialMetrics)
    private readonly metrics?: FinancialMetrics,
    @Optional()
    @Inject(JsonLogger)
    private readonly logger?: JsonLogger,
  ) {}

  findWalletById(scope: QueryScope, walletId: string): Promise<WalletView> {
    return this.transactions.transaction(async (session) =>
      walletView(await this.requireWallet(session, scope, walletId)),
    );
  }

  listLedgerPageByWallet(
    scope: QueryScope,
    walletId: string,
    limit: number,
    cursor: LedgerCursor | null,
  ): Promise<WalletLedgerPageView> {
    return this.transactions.transaction(async (session) => {
      const wallet = await this.requireWallet(session, scope, walletId);
      const rows = await session.walletLedger.findCursorPageByWallet(
        scope.id,
        walletId,
        limit + 1,
        cursor,
      );
      return { ...toLedgerPage(rows, limit), currency: wallet.currency };
    });
  }

  findTransactionById(
    scope: QueryScope,
    transactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.transaction(async (session) => {
      const transaction =
        await session.wagerTransactions.findById(transactionId);
      if (transaction === null || transaction.provider_id !== scope.id) {
        // A transaction belonging to another provider is reported as missing,
        // so the response does not confirm that the ID exists.
        throw new WagerTransactionNotFoundError(
          `Transaction "${transactionId}" was not found`,
        );
      }
      return wagerTransactionView(transaction);
    });
  }

  findTransactionByExternalId(
    scope: QueryScope,
    externalTransactionId: string,
  ): Promise<WagerTransactionView> {
    return this.transactions.transaction(async (session) => {
      const transaction =
        await session.wagerTransactions.findByProviderAndExternalTransactionId(
          scope.id,
          externalTransactionId,
        );
      if (transaction === null) {
        throw new WagerTransactionNotFoundError(
          `Transaction "${externalTransactionId}" was not found for this provider`,
        );
      }
      return wagerTransactionView(transaction);
    });
  }

  /**
   * A request refused before any transaction existed (unknown player or
   * wallet, inactive provider) is still recorded as a financial operation, so
   * the provider can always learn the fate of an external ID. Unknown IDs are
   * still not found.
   */
  async findTransactionOrOperationByExternalId(
    scope: QueryScope,
    externalTransactionId: string,
  ): Promise<ExternalTransactionLookupView> {
    try {
      return {
        kind: "transaction",
        transaction: await this.findTransactionByExternalId(
          scope,
          externalTransactionId,
        ),
      };
    } catch (error) {
      if (!(error instanceof WagerTransactionNotFoundError)) {
        throw error;
      }
    }
    return {
      kind: "operation",
      operation: await this.getOperationStatus(scope, externalTransactionId),
    };
  }

  /**
   * Recomputes the balance from the ledger and compares it with the stored
   * one. The comparison runs through `Money`, never on parsed floats.
   */
  reconcileWallet(
    scope: QueryScope,
    walletId: string,
  ): Promise<ReconciliationView> {
    return this.transactions.transaction(async (session) => {
      const wallet = await this.requireWallet(session, scope, walletId);
      const reconciliation = await session.walletLedger.reconcileWallet(
        scope.id,
        walletId,
      );
      if (reconciliation === null) {
        throw new WalletNotFoundError(`Wallet "${walletId}" was not found`);
      }

      const stored = Money.fromDecimal(
        reconciliation.stored_balance,
        wallet.currency,
      );
      const calculated = Money.fromDecimal(
        reconciliation.calculated_balance,
        wallet.currency,
      );
      const consistent = stored.compare(calculated) === 0;
      this.metrics?.recordReconciliation(consistent);
      if (!consistent) {
        this.logger?.emit("warn", "wallet.reconciliation.mismatch", {
          providerId: scope.id,
          walletId,
          status: "INCONSISTENT",
        });
      }

      return {
        walletId,
        storedBalance: {
          amount: stored.toDecimal(),
          currency: stored.currency,
        },
        calculatedBalance: {
          amount: calculated.toDecimal(),
          currency: calculated.currency,
        },
        difference: {
          amount: reconciliation.difference,
          currency: stored.currency,
        },
        consistent,
        checkedEntries: reconciliation.checked_entries,
      };
    });
  }

  getOperationStatus(
    scope: QueryScope,
    externalTransactionId: string,
  ): Promise<OperationStatusView> {
    return this.transactions.transaction(async (session) => {
      const operation =
        await session.financialOperations.findByExternalTransactionId(
          scope.id,
          externalTransactionId,
        );
      if (operation === null) {
        throw new FinancialOperationNotFoundError(
          `Operation "${externalTransactionId}" was not found`,
        );
      }

      const { status, failureCode } = readSnapshot(operation.response_snapshot);
      return {
        externalTransactionId: operation.external_transaction_id,
        status,
        failureCode,
        pending: operation.completed_at === null,
        responseHttpStatus: operation.response_http_status,
        createdAt: isoTimestamp(operation.created_at),
        completedAt: nullableIsoTimestamp(operation.completed_at),
      };
    });
  }

  checkDatabase(): Promise<void> {
    return this.transactions.transaction(async (session) => {
      await session.providers.findByCode("__health_check__");
    });
  }

  private async requireWallet(
    session: PersistenceSession,
    scope: QueryScope,
    walletId: string,
  ) {
    const wallet = await session.wallets.findByProviderAndId(
      scope.id,
      walletId,
    );
    if (wallet === null) {
      throw new WalletNotFoundError(`Wallet "${walletId}" was not found`);
    }
    return wallet;
  }
}

function toLedgerPage(
  rows: readonly WalletLedgerRow[],
  limit: number,
): LedgerPageView {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items: items.map(ledgerEntryView),
    nextCursor: hasMore && last !== undefined ? ledgerCursorAfter(last) : null,
  };
}

/**
 * Reads the stored response snapshot. It is validated rather than trusted: a
 * snapshot that cannot be parsed is a corrupted financial record, so it raises
 * instead of being reported as an unknown status.
 */
function readSnapshot(snapshot: unknown): {
  readonly status: string;
  readonly failureCode: string | null;
} {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    !("status" in snapshot)
  ) {
    throw new Error(
      "Persisted financial operation has an invalid response snapshot",
    );
  }

  const status = snapshot.status;
  if (
    typeof status !== "string" ||
    !Object.values(WagerTransactionStatus).some(
      (candidate) => candidate === status,
    )
  ) {
    throw new Error("Persisted financial operation has an invalid status");
  }

  const failureCode = "failureCode" in snapshot ? snapshot.failureCode : null;
  if (failureCode !== null && typeof failureCode !== "string") {
    if (failureCode !== undefined) {
      throw new Error(
        "Persisted financial operation has an invalid failure code",
      );
    }
    return { status, failureCode: null };
  }

  return { status, failureCode: failureCode ?? null };
}
