import type {
  WagerTransactionRow,
  WalletLedgerRow,
  WalletRow,
} from "../persistence/repositories.js";
import type {
  LedgerCursor,
  LedgerEntryView,
  WagerTransactionView,
  WalletView,
} from "./types/index.js";

/**
 * The only place that translates persistence rows into read models. Column
 * names stop here; nothing downstream names one.
 */

export function walletView(row: WalletRow): WalletView {
  return {
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    currency: row.currency,
    balance: row.balance,
    version: row.version,
  };
}

export function ledgerEntryView(row: WalletLedgerRow): LedgerEntryView {
  return {
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    transactionId: row.wager_transaction_id,
    direction: row.entry_type,
    amount: row.amount,
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    createdAt: isoTimestamp(row.created_at),
  };
}

export function wagerTransactionView(
  row: WagerTransactionRow,
): WagerTransactionView {
  return {
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    walletId: row.wallet_id,
    financialOperationId: row.financial_operation_id,
    externalTransactionId: row.external_transaction_id,
    externalReferenceTransactionId: row.external_reference_transaction_id,
    referenceTransactionId: row.reference_transaction_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    failureCode: row.failure_code,
    createdAt: isoTimestamp(row.created_at),
    processedAt: nullableIsoTimestamp(row.processed_at),
    completedAt: nullableIsoTimestamp(row.completed_at),
  };
}

/**
 * Builds the cursor that resumes a keyset page after the given row.
 *
 * `cursor_created_at` is the timestamp in the exact text form PostgreSQL
 * compares, which the repository selects alongside the row. Falling back to
 * the parsed `Date` loses sub-millisecond precision, so two entries written
 * inside the same millisecond could be skipped or repeated across a page
 * boundary; the tiebreak on `id` is what keeps that bounded.
 */
export function ledgerCursorAfter(row: WalletLedgerRow): LedgerCursor {
  return {
    createdAt: row.cursor_created_at ?? row.created_at.toISOString(),
    id: row.id,
  };
}

export function isoTimestamp(value: Date | string): string {
  return new Date(value).toISOString();
}

export function nullableIsoTimestamp(
  value: Date | string | null,
): string | null {
  return value === null ? null : isoTimestamp(value);
}
