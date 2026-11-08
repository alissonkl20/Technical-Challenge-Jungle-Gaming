import { randomUUID } from "node:crypto";
import type {
  PersistenceSession,
  WalletRow,
} from "../../src/modules/finance/persistence/repositories.js";

type NewWallet = Pick<
  WalletRow,
  "id" | "provider_id" | "player_id" | "currency" | "balance" | "version"
>;

/**
 * Inserts a wallet the way the application opens one: a non-zero balance is
 * backed, in the same SQL transaction, by a PROCESSED OPENING transaction and
 * its CREDIT from zero. PostgreSQL refuses a funded wallet without it, so a
 * fixture can never start from a balance the Ledger does not explain.
 */
export async function createWalletWithOpening(
  session: PersistenceSession,
  wallet: NewWallet,
): Promise<WalletRow> {
  const created = await session.wallets.create(wallet);
  if (/^0+(\.0+)?$/.test(wallet.balance)) {
    return created;
  }

  const openingId = randomUUID();
  const openedAt = new Date();
  await session.wagerTransactions.create({
    id: openingId,
    provider_id: wallet.provider_id,
    player_id: wallet.player_id,
    wallet_id: wallet.id,
    financial_operation_id: null,
    external_transaction_id: null,
    external_reference_transaction_id: null,
    reference_transaction_id: null,
    round_id: null,
    game_id: null,
    kind: "OPENING",
    status: "PROCESSED",
    amount: wallet.balance,
    currency: wallet.currency,
    failure_code: null,
    reference_attempts: 0,
    next_reference_attempt_at: null,
    reference_expires_at: null,
    processed_at: openedAt,
    completed_at: openedAt,
  });
  await session.walletLedger.create({
    id: randomUUID(),
    provider_id: wallet.provider_id,
    player_id: wallet.player_id,
    wallet_id: wallet.id,
    wager_transaction_id: openingId,
    amount: wallet.balance,
    entry_type: "CREDIT",
    balance_before: "0.00",
    balance_after: wallet.balance,
  });
  return created;
}
