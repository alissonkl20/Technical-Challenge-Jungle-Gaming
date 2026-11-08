import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type { OutboxRepository, OutboxRow } from "./repositories.js";

export class PostgresOutboxRepository
  extends PostgresRepository
  implements OutboxRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "outbox");
  }

  findById(id: string): Promise<OutboxRow | null> {
    return this.findOne<OutboxRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  async findOldestUnpublishedAgeMs(): Promise<number> {
    const rows = await this.em.execute<{ age_ms: string | number | null }[]>(
      `SELECT COALESCE(
         EXTRACT(EPOCH FROM (now() - MIN(created_at))) * 1000,
         0
       ) AS age_ms
       FROM ${this.tableName}
       WHERE status IN ('PENDING', 'PROCESSING')`,
    );
    const age = Number(rows[0]?.age_ms ?? 0);
    if (!Number.isFinite(age) || age < 0) {
      throw new Error("PostgreSQL returned an invalid Outbox lag");
    }
    return age;
  }

  create(
    event: Pick<OutboxRow, "id" | "aggregate_id" | "event_type" | "payload">,
  ): Promise<OutboxRow> {
    return this.insert<OutboxRow>(
      ["id", "aggregate_id", "event_type", "payload"],
      [
        event.id,
        event.aggregate_id,
        event.event_type,
        JSON.stringify(event.payload),
      ],
    );
  }

  async claimDue(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<OutboxRow[]> {
    return this.em.execute<OutboxRow[]>(
      `WITH candidates AS (
         SELECT id
         FROM ${this.tableName}
         WHERE (status = 'PENDING' AND next_attempt_at <= now())
            OR (status = 'PROCESSING' AND locked_until <= now())
         ORDER BY next_attempt_at, created_at, id
         LIMIT ?
         FOR UPDATE SKIP LOCKED
       )
       UPDATE ${this.tableName} AS event
       SET status = 'PROCESSING',
           attempts = event.attempts + 1,
           locked_by = ?,
           locked_until = now() + (? * interval '1 millisecond')
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING event.*`,
      [limit, workerId, leaseMs],
    );
  }

  async recoverExpiredLeases(): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
       SET status = 'PENDING',
           locked_by = NULL,
           locked_until = NULL,
           next_attempt_at = now(),
           last_error = COALESCE(last_error, 'Lease expired before publication confirmation')
       WHERE status = 'PROCESSING' AND locked_until <= now()
       RETURNING id`,
    );
    return rows.length;
  }

  async markPublished(
    id: string,
    workerId: string,
    publishedAt: Date,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
       SET status = 'PUBLISHED',
           locked_by = NULL,
           locked_until = NULL,
           last_error = NULL,
           last_attempt_at = ?,
           published_at = ?
       WHERE id = ? AND status = 'PROCESSING' AND locked_by = ?
       RETURNING id`,
      [publishedAt, publishedAt, id, workerId],
    );
    return rows.length === 1;
  }

  /**
   * Records a failed publication attempt under the lease held by `workerId`.
   * When `exhausted` is true the event becomes FAILED in the same statement:
   * it is never claimed again and keeps its last error for the operator.
   * Returns false when the lease was lost, in which case nothing changes.
   */
  async scheduleRetry(
    id: string,
    workerId: string,
    error: string,
    nextAttemptAt: Date,
    exhausted: boolean,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
       SET status = CASE WHEN ? THEN 'FAILED' ELSE 'PENDING' END,
           locked_by = NULL,
           locked_until = NULL,
           last_error = ?,
           last_attempt_at = now(),
           next_attempt_at = ?,
           failed_at = CASE WHEN ? THEN now() ELSE NULL END
       WHERE id = ? AND status = 'PROCESSING' AND locked_by = ?
       RETURNING id`,
      [exhausted, error, nextAttemptAt, exhausted, id, workerId],
    );
    return rows.length === 1;
  }

  /**
   * Operator redrive: moves FAILED events back to PENDING with a fresh attempt
   * budget. The payload, identifiers and last error are kept for audit.
   */
  async redriveFailed(limit: number): Promise<number> {
    const rows = await this.em.execute<{ id: string }[]>(
      `UPDATE ${this.tableName}
       SET status = 'PENDING',
           attempts = 0,
           next_attempt_at = now(),
           failed_at = NULL
       WHERE id IN (
         SELECT id FROM ${this.tableName}
          WHERE status = 'FAILED'
          ORDER BY failed_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id`,
      [limit],
    );
    return rows.length;
  }

  async countFailed(): Promise<number> {
    const rows = await this.em.execute<{ total: string | number }[]>(
      `SELECT count(*) AS total FROM ${this.tableName} WHERE status = 'FAILED'`,
    );
    return Number(rows[0]?.total ?? 0);
  }
}
