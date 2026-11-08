import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type {
  WalletLedgerCursor,
  WalletLedgerReconciliation,
  WalletLedgerRepository,
  WalletLedgerRow,
} from "./repositories.js";

export class PostgresWalletLedgerRepository
  extends PostgresRepository
  implements WalletLedgerRepository
{
  private readonly walletTableName: string;

  constructor(em: PostgreSqlEntityManager) {
    super(em, "wallet_ledger_entries");
    const schema = em.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    this.walletTableName = `"${schema}"."wallets"`;
  }

  findByTransactionId(transactionId: string): Promise<WalletLedgerRow | null> {
    return this.findOne<WalletLedgerRow>(
      `SELECT * FROM ${this.tableName} WHERE wager_transaction_id = ?`,
      [transactionId],
    );
  }

  findCursorPageByWallet(
    providerId: string,
    walletId: string,
    limit: number,
    cursor: WalletLedgerCursor | null,
  ): Promise<WalletLedgerRow[]> {
    return this.em.execute<WalletLedgerRow[]>(
      `SELECT *, created_at::text AS cursor_created_at
       FROM ${this.tableName}
       WHERE provider_id = ? AND wallet_id = ?
         AND (?::timestamptz IS NULL OR
           (created_at, id) < (?::timestamptz, ?::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [
        providerId,
        walletId,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit,
      ],
    );
  }

  reconcileWallet(
    providerId: string,
    walletId: string,
  ): Promise<WalletLedgerReconciliation | null> {
    return this.findOne<WalletLedgerReconciliation>(
      `SELECT
         wallet.balance::text AS stored_balance,
         COALESCE(
           SUM(CASE WHEN ledger.entry_type = 'CREDIT'
             THEN ledger.amount ELSE -ledger.amount END),
           0
         )::numeric(20, 2)::text AS calculated_balance,
         (wallet.balance - COALESCE(
           SUM(CASE WHEN ledger.entry_type = 'CREDIT'
             THEN ledger.amount ELSE -ledger.amount END),
           0
         ))::numeric(20, 2)::text AS difference,
         count(ledger.id)::integer AS checked_entries
       FROM ${this.walletTableName} wallet
       LEFT JOIN ${this.tableName} ledger
         ON ledger.wallet_id = wallet.id
        AND ledger.provider_id = wallet.provider_id
       WHERE wallet.provider_id = ? AND wallet.id = ?
       GROUP BY wallet.id`,
      [providerId, walletId],
    );
  }

  create(
    entry: Pick<
      WalletLedgerRow,
      | "id"
      | "provider_id"
      | "player_id"
      | "wallet_id"
      | "wager_transaction_id"
      | "amount"
      | "entry_type"
      | "balance_before"
      | "balance_after"
    >,
  ): Promise<WalletLedgerRow> {
    return this.insert<WalletLedgerRow>(
      [
        "id",
        "provider_id",
        "player_id",
        "wallet_id",
        "wager_transaction_id",
        "amount",
        "entry_type",
        "balance_before",
        "balance_after",
      ],
      [
        entry.id,
        entry.provider_id,
        entry.player_id,
        entry.wallet_id,
        entry.wager_transaction_id,
        entry.amount,
        entry.entry_type,
        entry.balance_before,
        entry.balance_after,
      ],
    );
  }
}
