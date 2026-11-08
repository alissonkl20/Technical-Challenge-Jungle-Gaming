import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type {
  WagerTransactionRepository,
  WagerTransactionRow,
} from "./repositories.js";

export class PostgresWagerTransactionRepository
  extends PostgresRepository
  implements WagerTransactionRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "wager_transactions");
  }

  findById(id: string): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  findAllByProviderAndPlayer(
    providerId: string,
    playerId: string,
    limit: number,
    offset: number,
  ): Promise<WagerTransactionRow[]> {
    return this.em.execute<WagerTransactionRow[]>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND player_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [providerId, playerId, limit, offset],
    );
  }

  findDuePendingReferences(limit: number): Promise<WagerTransactionRow[]> {
    return this.em.execute<WagerTransactionRow[]>(
      `SELECT * FROM ${this.tableName}
       WHERE status = 'PENDING_REFERENCE'
         AND next_reference_attempt_at <= now()
       ORDER BY next_reference_attempt_at, created_at, id
       LIMIT ?`,
      [limit],
    );
  }

  async countPendingReferences(): Promise<number> {
    const rows = await this.em.execute<{ total: string | number }[]>(
      `SELECT count(*) AS total FROM ${this.tableName} WHERE status = 'PENDING_REFERENCE'`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  findByIdForUpdate(id: string): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ? FOR UPDATE`,
      [id],
    );
  }

  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
  }

  findByProviderAndExternalTransactionIdForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND external_transaction_id = ?
       FOR UPDATE`,
      [providerId, externalTransactionId],
    );
  }

  findProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT * FROM ${this.tableName}
       WHERE reference_transaction_id = ?
         AND kind IN ('REFUND', 'ROLLBACK')
         AND status = 'PROCESSED'
       LIMIT 1`,
      [referenceTransactionId],
    );
  }

  findActiveBetResult(
    providerId: string,
    walletId: string,
    externalBetTransactionId: string,
    excludingTransactionId: string,
  ): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `SELECT r.* FROM ${this.tableName} r
       WHERE r.provider_id = ?
         AND r.wallet_id = ?
         AND r.external_reference_transaction_id = ?
         AND r.kind IN ('WIN', 'LOSS', 'REFUND')
         AND r.status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
         AND r.id <> ?
         AND NOT EXISTS (
           SELECT 1 FROM ${this.tableName} rb
            WHERE rb.reference_transaction_id = r.id
              AND rb.kind = 'ROLLBACK'
              AND rb.status = 'PROCESSED'
         )
       ORDER BY r.created_at, r.id
       LIMIT 1`,
      [providerId, walletId, externalBetTransactionId, excludingTransactionId],
    );
  }

  async deferPendingReference(id: string, delayMs: number): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
       SET reference_attempts = reference_attempts + 1,
           next_reference_attempt_at = now() + (? * interval '1 millisecond')
       WHERE id = ? AND status = 'PENDING_REFERENCE'
       RETURNING id`,
      [delayMs, id],
    );
    return rows.length === 1;
  }

  update(
    transaction: Pick<
      WagerTransactionRow,
      | "id"
      | "status"
      | "reference_transaction_id"
      | "failure_code"
      | "reference_attempts"
      | "next_reference_attempt_at"
      | "reference_expires_at"
      | "processed_at"
      | "completed_at"
    >,
  ): Promise<WagerTransactionRow | null> {
    return this.findOne<WagerTransactionRow>(
      `UPDATE ${this.tableName}
       SET status = ?,
           reference_transaction_id = ?,
           failure_code = ?,
           reference_attempts = ?,
           next_reference_attempt_at = ?,
           reference_expires_at = ?,
           processed_at = ?,
           completed_at = ?
       WHERE id = ?
       RETURNING *`,
      [
        transaction.status,
        transaction.reference_transaction_id,
        transaction.failure_code,
        transaction.reference_attempts,
        transaction.next_reference_attempt_at,
        transaction.reference_expires_at,
        transaction.processed_at,
        transaction.completed_at,
        transaction.id,
      ],
    );
  }

  create(
    transaction: Pick<
      WagerTransactionRow,
      | "id"
      | "provider_id"
      | "player_id"
      | "wallet_id"
      | "financial_operation_id"
      | "external_transaction_id"
      | "external_reference_transaction_id"
      | "reference_transaction_id"
      | "round_id"
      | "game_id"
      | "kind"
      | "status"
      | "amount"
      | "currency"
      | "failure_code"
      | "reference_attempts"
      | "next_reference_attempt_at"
      | "reference_expires_at"
      | "processed_at"
      | "completed_at"
    >,
  ): Promise<WagerTransactionRow> {
    return this.insert<WagerTransactionRow>(
      [
        "id",
        "provider_id",
        "player_id",
        "wallet_id",
        "financial_operation_id",
        "external_transaction_id",
        "external_reference_transaction_id",
        "reference_transaction_id",
        "round_id",
        "game_id",
        "kind",
        "status",
        "amount",
        "currency",
        "failure_code",
        "reference_attempts",
        "next_reference_attempt_at",
        "reference_expires_at",
        "processed_at",
        "completed_at",
      ],
      [
        transaction.id,
        transaction.provider_id,
        transaction.player_id,
        transaction.wallet_id,
        transaction.financial_operation_id,
        transaction.external_transaction_id,
        transaction.external_reference_transaction_id,
        transaction.reference_transaction_id,
        transaction.round_id,
        transaction.game_id,
        transaction.kind,
        transaction.status,
        transaction.amount,
        transaction.currency,
        transaction.failure_code,
        transaction.reference_attempts,
        transaction.next_reference_attempt_at,
        transaction.reference_expires_at,
        transaction.processed_at,
        transaction.completed_at,
      ],
    );
  }
}
