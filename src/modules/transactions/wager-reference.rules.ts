import {
  evaluateWagerReference,
  FailureCode,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type Wallet,
} from "../finance/domain/index.js";
import type {
  PersistenceSession,
  WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import type {
  NormalizedWagerInput,
  WagerReferenceResolution,
} from "./types/index.js";
import { wagerTransactionFromRow } from "./wager-transaction.mapper.js";

/**
 * Loads the referenced transaction and asks the domain policy to decide. The
 * policy sees domain objects only; this function owns the lookups.
 */
export async function resolveWagerReference(
  session: PersistenceSession,
  providerId: string,
  wallet: Wallet,
  wager: WagerTransaction,
  input: NormalizedWagerInput,
): Promise<WagerReferenceResolution> {
  const externalReferenceId = input.externalReferenceTransactionId;
  if (externalReferenceId === undefined) {
    return { kind: "none", transaction: null };
  }

  const row =
    await session.wagerTransactions.findByProviderAndExternalTransactionIdForUpdate(
      providerId,
      externalReferenceId,
    );
  if (row === null) {
    return { kind: "pending", transaction: null };
  }

  const decision = evaluateWagerReference(wager, wagerTransactionFromRow(row), {
    playerId: wallet.playerId,
    walletId: wallet.id,
    currency: wallet.currency,
    ...(input.roundId === undefined ? {} : { roundId: input.roundId }),
  });

  switch (decision.kind) {
    case "not-required":
      return { kind: "none", transaction: null };
    case "pending":
      return { kind: "pending", transaction: null };
    case "rejected":
      return {
        kind: "rejected",
        failureCode: decision.failureCode,
        transaction: row,
      };
    default:
      return { kind: "resolved", transaction: row };
  }
}

/**
 * Adds the checks that need a query. The caller holds the wallet lock, and
 * every operation that settles a BET locks the same wallet first, so these
 * reads cannot race with another settlement of the same BET. PostgreSQL
 * enforces the same rules with triggers in case the application is bypassed.
 *
 * - A BET has one active result (WIN, LOSS or REFUND): the first valid one
 *   recorded wins. A result still waiting for its BET already holds the slot.
 * - A target carries at most one processed reversal.
 * - A ROLLBACK of a REFUND requires an intact chain back to the original BET.
 */
export async function resolveAndValidateWagerReference(
  session: PersistenceSession,
  providerId: string,
  wallet: Wallet,
  wager: WagerTransaction,
  input: NormalizedWagerInput,
): Promise<WagerReferenceResolution> {
  const resolution = await resolveWagerReference(
    session,
    providerId,
    wallet,
    wager,
    input,
  );
  if (resolution.kind === "none" || resolution.kind === "rejected") {
    return resolution;
  }

  // Checked only once the event is known to be valid against everything that
  // exists: an event rejected above never reserves the result.
  const externalBetId = wager.externalReferenceTransactionId;
  if (wager.isBetResult() && externalBetId !== undefined) {
    const activeResult = await session.wagerTransactions.findActiveBetResult(
      providerId,
      wallet.id,
      externalBetId,
      wager.id,
    );
    if (activeResult !== null) {
      return {
        kind: "rejected",
        failureCode: FailureCode.ReferenceAlreadySettled,
        transaction: resolution.transaction,
      };
    }
  }
  if (resolution.kind === "pending") {
    return resolution;
  }

  wager.setReferenceTransactionId(resolution.transaction.id);

  if (
    wager.kind === WagerTransactionKind.ROLLBACK &&
    resolution.transaction.kind === WagerTransactionKind.REFUND &&
    !(await hasValidRefundChain(session, resolution.transaction))
  ) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceChainInvalid,
      transaction: resolution.transaction,
    };
  }

  // A reversed target can be neither reversed again nor settled: a result of
  // a BET that was refunded or rolled back is refused.
  const previousReversal =
    await session.wagerTransactions.findProcessedReversal(
      resolution.transaction.id,
    );
  if (previousReversal !== null) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceAlreadyReversed,
      transaction: resolution.transaction,
    };
  }

  return resolution;
}

/**
 * A ROLLBACK may only reverse a REFUND that reversed a matching processed BET
 * and that actually produced a ledger entry.
 */
export async function hasValidRefundChain(
  session: PersistenceSession,
  refund: WagerTransactionRow,
): Promise<boolean> {
  const originalBetId = refund.reference_transaction_id;
  if (originalBetId === null) {
    return false;
  }

  const originalBet =
    await session.wagerTransactions.findByIdForUpdate(originalBetId);
  if (
    originalBet === null ||
    originalBet.kind !== WagerTransactionKind.BET ||
    originalBet.status !== WagerTransactionStatus.PROCESSED ||
    originalBet.provider_id !== refund.provider_id ||
    originalBet.player_id !== refund.player_id ||
    originalBet.wallet_id !== refund.wallet_id ||
    originalBet.currency !== refund.currency ||
    originalBet.amount !== refund.amount ||
    originalBet.round_id !== refund.round_id
  ) {
    return false;
  }

  const originalReversal =
    await session.wagerTransactions.findProcessedReversal(originalBet.id);
  if (originalReversal?.id !== refund.id) {
    return false;
  }

  return (await session.walletLedger.findByTransactionId(refund.id)) !== null;
}
