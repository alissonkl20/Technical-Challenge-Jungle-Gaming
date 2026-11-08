import type {
  LedgerEntryView,
  OperationStatusView,
  SubmitWagerOutcome,
  WagerTransactionView,
  WalletLedgerPageView,
  WalletView,
} from "../../finance/application/types/index.js";
import type { WalletSnapshot } from "../../finance/domain/index.js";
import { encodeLedgerCursor } from "./ledger-page.dto.js";

/**
 * The published response shapes. They are written out field by field rather
 * than spreading a view, so adding a field to a read model cannot leak into a
 * provider-facing response by accident.
 */

export function openedWalletDto(snapshot: WalletSnapshot) {
  return {
    id: snapshot.id,
    playerId: snapshot.playerId,
    balance: { amount: snapshot.balance, currency: snapshot.currency },
    version: snapshot.version,
  };
}

export function walletDto(wallet: WalletView) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: { amount: wallet.balance, currency: wallet.currency },
    version: wallet.version,
  };
}

export function ledgerPageDto(page: WalletLedgerPageView, limit: number) {
  return {
    items: page.items.map((entry) => ledgerEntryDto(entry, page.currency)),
    limit,
    nextCursor:
      page.nextCursor === null ? null : encodeLedgerCursor(page.nextCursor),
  };
}

function ledgerEntryDto(entry: LedgerEntryView, currency: string) {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: { amount: entry.amount, currency },
    balanceBefore: { amount: entry.balanceBefore, currency },
    balanceAfter: { amount: entry.balanceAfter, currency },
    createdAt: entry.createdAt,
  };
}

export function submittedTransactionDto(outcome: SubmitWagerOutcome) {
  return {
    transactionId: outcome.transactionId,
    externalTransactionId: outcome.externalTransactionId,
    status: outcome.status,
    balance: outcome.balance,
    failureCode: outcome.failureCode,
    idempotentReplay: outcome.idempotentReplay,
  };
}

export function transactionDto(transaction: WagerTransactionView) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    externalTransactionId: transaction.externalTransactionId,
    referenceExternalTransactionId: transaction.externalReferenceTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: { amount: transaction.amount, currency: transaction.currency },
    failureCode: transaction.failureCode,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt,
  };
}

/**
 * A request refused before any transaction existed, answered with the same
 * shape as a transaction and no transaction ID.
 */
export function operationAsTransactionDto(
  providerId: string,
  operation: OperationStatusView,
) {
  return {
    transactionId: null,
    providerId,
    externalTransactionId: operation.externalTransactionId,
    status: operation.status,
    failureCode: operation.failureCode,
    createdAt: operation.createdAt,
    processedAt: null,
  };
}
