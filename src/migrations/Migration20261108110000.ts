import { Migration } from "@mikro-orm/migrations";

/**
 * Terminal state for outbox events whose publication attempts are exhausted.
 *
 * FAILED rows are never claimed automatically and never deleted. They keep
 * their payload, attempt count, and last error, and an operator may move them
 * back to PENDING with an explicit redrive.
 */
export class Migration20261108110000 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE outbox
        ADD COLUMN last_attempt_at timestamptz NULL,
        ADD COLUMN failed_at timestamptz NULL;

      ALTER TABLE outbox DROP CONSTRAINT ck_outbox_status;
      ALTER TABLE outbox
        ADD CONSTRAINT ck_outbox_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

      ALTER TABLE outbox
        ADD CONSTRAINT ck_outbox_failed_state
          CHECK (
            (status = 'FAILED' AND failed_at IS NOT NULL
              AND locked_by IS NULL AND locked_until IS NULL)
            OR
            (status <> 'FAILED' AND failed_at IS NULL)
          );

      DROP INDEX IF EXISTS ix_outbox_due;
      CREATE INDEX ix_outbox_due
        ON outbox (status, next_attempt_at, created_at)
        WHERE status = 'PENDING';
    `);
  }

  override down(): void {
    this.addSql(`
      DROP INDEX IF EXISTS ix_outbox_due;
      CREATE INDEX ix_outbox_due
        ON outbox (status, next_attempt_at, created_at);

      ALTER TABLE outbox DROP CONSTRAINT ck_outbox_failed_state;
      ALTER TABLE outbox DROP CONSTRAINT ck_outbox_status;
      ALTER TABLE outbox
        ADD CONSTRAINT ck_outbox_status
          CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED'));

      ALTER TABLE outbox
        DROP COLUMN IF EXISTS failed_at,
        DROP COLUMN IF EXISTS last_attempt_at;
    `);
  }
}
