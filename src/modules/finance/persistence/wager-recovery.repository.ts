import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type {
  WagerRecoveryRepository,
  WagerRecoveryRow,
  WagerRecoveryStatus,
} from "./repositories.js";

export class PostgresWagerRecoveryRepository
  extends PostgresRepository
  implements WagerRecoveryRepository
{
  private readonly wagers: string;
  private readonly outbox: string;

  constructor(em: PostgreSqlEntityManager) {
    super(em, "wager_recoveries");
    const schema = em.config.get("schema") ?? "public";
    this.wagers = `"${schema}"."wager_transactions"`;
    this.outbox = `"${schema}"."outbox"`;
  }

  async recordPublicationFailure(
    wagerTransactionId: string,
    attempts: number,
    error: string,
    exhausted: boolean,
  ): Promise<void> {
    // INSERT ... SELECT tracks only a PROCESSED wager that moved or settled
    // money. The upsert never touches a row that already left the open states.
    await this.em.execute(
      `INSERT INTO ${this.tableName}
         (wager_transaction_id, provider_id, wallet_id, status,
          recovery_attempts, last_error, exhausted_at)
       SELECT w.id, w.provider_id, w.wallet_id,
              CASE WHEN ? THEN 'COMPENSATION_REQUIRED' ELSE 'PENDING_RECOVERY' END,
              ?, ?, CASE WHEN ? THEN now() ELSE NULL END
         FROM ${this.wagers} w
        WHERE w.id = ?
          AND w.status = 'PROCESSED'
          AND w.kind IN ('BET', 'WIN', 'LOSS', 'REFUND')
       ON CONFLICT (wager_transaction_id) DO UPDATE
         SET recovery_attempts = GREATEST(
               ${this.tableName}.recovery_attempts, EXCLUDED.recovery_attempts),
             last_error = EXCLUDED.last_error,
             status = CASE WHEN ? THEN 'COMPENSATION_REQUIRED'
                           ELSE ${this.tableName}.status END,
             exhausted_at = CASE WHEN ? THEN now()
                                 ELSE ${this.tableName}.exhausted_at END,
             updated_at = now()
         WHERE ${this.tableName}.status = 'PENDING_RECOVERY'`,
      [
        exhausted,
        attempts,
        error,
        exhausted,
        wagerTransactionId,
        exhausted,
        exhausted,
      ],
    );
  }

  async markRecoveredIfPublished(wagerTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
          SET status = 'RECOVERED', resolved_at = now(), updated_at = now()
        WHERE wager_transaction_id = ?
          AND status = 'PENDING_RECOVERY'
          AND NOT EXISTS (
            SELECT 1 FROM ${this.outbox} event
             WHERE event.status <> 'PUBLISHED'
               AND event.event_type IN
                 ('WagerTransactionProcessed', 'WalletBalanceChanged')
               AND (event.aggregate_id = ?
                 OR event.payload->'data'->>'transactionId' = ?::text))
        RETURNING id`,
      [wagerTransactionId, wagerTransactionId, wagerTransactionId],
    );
    return rows.length === 1;
  }

  findDueForCompensation(limit: number): Promise<WagerRecoveryRow[]> {
    return this.em.execute<WagerRecoveryRow[]>(
      `SELECT * FROM ${this.tableName}
        WHERE status = 'COMPENSATION_REQUIRED'
          AND next_compensation_attempt_at <= now()
        ORDER BY next_compensation_attempt_at, id
        LIMIT ?`,
      [limit],
    );
  }

  findByIdForUpdateSkipLocked(id: string): Promise<WagerRecoveryRow | null> {
    // SKIP LOCKED: another instance compensating this wager right now owns it;
    // this one moves on instead of waiting to find it resolved.
    return this.findOne<WagerRecoveryRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ? FOR UPDATE SKIP LOCKED`,
      [id],
    );
  }

  findByWagerTransactionId(
    wagerTransactionId: string,
  ): Promise<WagerRecoveryRow | null> {
    return this.findOne<WagerRecoveryRow>(
      `SELECT * FROM ${this.tableName} WHERE wager_transaction_id = ?`,
      [wagerTransactionId],
    );
  }

  async resolve(
    id: string,
    status: WagerRecoveryStatus,
    compensationTransactionId: string | null,
    failureCode: string | null,
  ): Promise<void> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
          SET status = ?, compensation_transaction_id = ?, failure_code = ?,
              compensation_attempts = compensation_attempts + 1,
              resolved_at = now(), updated_at = now()
        WHERE id = ? AND status = 'COMPENSATION_REQUIRED'
        RETURNING id`,
      [status, compensationTransactionId, failureCode, id],
    );
    if (rows.length !== 1) {
      throw new Error(`Wager recovery ${id} is not awaiting compensation`);
    }
  }

  async deferCompensation(
    id: string,
    delayMs: number,
    error: string,
    exhausted: boolean,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
          SET compensation_attempts = compensation_attempts + 1,
              next_compensation_attempt_at =
                now() + (? * interval '1 millisecond'),
              last_error = ?,
              status = CASE WHEN ? THEN 'COMPENSATION_FAILED' ELSE status END,
              failure_code = CASE WHEN ? THEN 'COMPENSATION_EXHAUSTED'
                                  ELSE failure_code END,
              resolved_at = CASE WHEN ? THEN now() ELSE resolved_at END,
              updated_at = now()
        WHERE id = ? AND status = 'COMPENSATION_REQUIRED'
        RETURNING id`,
      [delayMs, error, exhausted, exhausted, exhausted, id],
    );
    return rows.length === 1;
  }
}
