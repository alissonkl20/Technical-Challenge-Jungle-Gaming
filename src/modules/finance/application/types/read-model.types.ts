/**
 * The read side of the finance module, expressed without column names.
 *
 * These views are the boundary between persistence and every reader. The HTTP
 * layer shapes its responses from them, so a renamed column breaks a mapper in
 * this module at compile time instead of silently changing a published
 * response body.
 *
 * Amounts stay decimal strings, exactly as `NUMERIC(20,2)` returns them. They
 * are never parsed into a `number` on the way out.
 */

export interface WalletView {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
}

export type LedgerDirectionView = "CREDIT" | "DEBIT";

export interface LedgerEntryView {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirectionView;
  readonly amount: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: string;
}

export interface WagerTransactionView {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly financialOperationId: string | null;
  readonly externalTransactionId: string | null;
  readonly externalReferenceTransactionId: string | null;
  readonly referenceTransactionId: string | null;
  readonly roundId: string | null;
  readonly gameId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly processedAt: string | null;
  readonly completedAt: string | null;
}

/** Keyset cursor over `(created_at, id)`, so a page is stable while entries append. */
export interface LedgerCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface LedgerPageView {
  readonly items: readonly LedgerEntryView[];
  readonly nextCursor: LedgerCursor | null;
}

/** A ledger page for one wallet, which carries that wallet's currency. */
export interface WalletLedgerPageView extends LedgerPageView {
  readonly currency: string;
}

export interface MoneyView {
  readonly amount: string;
  readonly currency: string;
}

export interface ReconciliationView {
  readonly walletId: string;
  readonly storedBalance: MoneyView;
  readonly calculatedBalance: MoneyView;
  readonly difference: MoneyView;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface OperationStatusView {
  readonly externalTransactionId: string;
  readonly status: string;
  readonly failureCode: string | null;
  readonly pending: boolean;
  readonly responseHttpStatus: number;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

/**
 * What a provider learns about an external transaction ID: the transaction,
 * or, when the request was refused before one existed, its operation.
 */
export type ExternalTransactionLookupView =
  | { readonly kind: "transaction"; readonly transaction: WagerTransactionView }
  | { readonly kind: "operation"; readonly operation: OperationStatusView };

export interface SubmitWagerOutcome {
  readonly httpStatus: number;
  readonly transactionId: string | null;
  readonly externalTransactionId: string;
  readonly status: string;
  readonly balance: MoneyView | null;
  readonly failureCode: string | null;
  readonly idempotentReplay: boolean;
}
