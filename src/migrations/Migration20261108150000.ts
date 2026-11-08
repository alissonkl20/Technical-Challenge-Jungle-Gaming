import { Migration } from "@mikro-orm/migrations";

/**
 * Recovery and compensation of a committed wager whose post-commit work could
 * not be completed.
 *
 * The only post-commit step with persisted state is publishing the Outbox
 * events of the financial operation (SQS ACK and the HTTP response are
 * recovered by idempotent redelivery). When publishing a
 * WagerTransactionProcessed or WalletBalanceChanged event fails, the wager gets
 * one row here:
 *
 *   PENDING_RECOVERY       publication is being retried (Outbox backoff)
 *   RECOVERED              every event of the wager was published   (terminal)
 *   COMPENSATION_REQUIRED  the Outbox exhausted its attempts
 *   COMPENSATED            a compensating ROLLBACK was committed     (terminal)
 *   COMPENSATION_NOT_REQUIRED  nothing to neutralize: a LOSS, or the
 *                          wager was already reversed                (terminal)
 *   COMPENSATION_REJECTED  the compensating ROLLBACK was refused by a
 *                          business rule, e.g. funds already spent  (terminal)
 *   COMPENSATION_FAILED    the compensation itself kept failing     (terminal)
 *
 * Guarantees held by PostgreSQL:
 * - one recovery per wager (UNIQUE), so compensation cannot be started twice;
 * - COMPENSATED only with a PROCESSED ROLLBACK of that very wager, which is
 *   visible only once its Ledger entry is in the same commit;
 * - terminal rows are immutable and no row can be deleted.
 */
export class Migration20261108150000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      CREATE TABLE ${schema}.wager_recoveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        wager_transaction_id uuid NOT NULL,
        provider_id uuid NOT NULL,
        wallet_id uuid NOT NULL,
        status varchar(40) NOT NULL,
        recovery_attempts integer NOT NULL DEFAULT 0,
        compensation_attempts integer NOT NULL DEFAULT 0,
        next_compensation_attempt_at timestamptz NOT NULL DEFAULT now(),
        last_error text NULL,
        compensation_transaction_id uuid NULL,
        failure_code varchar(100) NULL,
        detected_at timestamptz NOT NULL DEFAULT now(),
        exhausted_at timestamptz NULL,
        resolved_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_wager_recoveries_wager UNIQUE (wager_transaction_id),
        CONSTRAINT fk_wager_recoveries_wager
          FOREIGN KEY (wager_transaction_id)
          REFERENCES ${schema}.wager_transactions (id) ON DELETE RESTRICT,
        CONSTRAINT fk_wager_recoveries_compensation
          FOREIGN KEY (compensation_transaction_id)
          REFERENCES ${schema}.wager_transactions (id) ON DELETE RESTRICT,
        CONSTRAINT ck_wager_recoveries_status CHECK (status IN (
          'PENDING_RECOVERY', 'RECOVERED', 'COMPENSATION_REQUIRED',
          'COMPENSATED', 'COMPENSATION_NOT_REQUIRED',
          'COMPENSATION_REJECTED', 'COMPENSATION_FAILED')),
        CONSTRAINT ck_wager_recoveries_attempts
          CHECK (recovery_attempts >= 0 AND compensation_attempts >= 0),
        CONSTRAINT ck_wager_recoveries_resolution CHECK (
          (status IN ('PENDING_RECOVERY', 'COMPENSATION_REQUIRED')
            AND resolved_at IS NULL)
          OR (status NOT IN ('PENDING_RECOVERY', 'COMPENSATION_REQUIRED')
            AND resolved_at IS NOT NULL)),
        CONSTRAINT ck_wager_recoveries_compensation CHECK (
          (status = 'COMPENSATED') = (compensation_transaction_id IS NOT NULL)),
        CONSTRAINT ck_wager_recoveries_exhausted CHECK (
          status IN ('PENDING_RECOVERY', 'RECOVERED') OR exhausted_at IS NOT NULL)
      );

      CREATE INDEX ix_wager_recoveries_compensation_due
        ON ${schema}.wager_recoveries (next_compensation_attempt_at)
        WHERE status = 'COMPENSATION_REQUIRED';

      CREATE FUNCTION ${schema}.validate_wager_recovery() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'wager recoveries are append-only'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'UPDATE' AND (
          OLD.status NOT IN ('PENDING_RECOVERY', 'COMPENSATION_REQUIRED')
          OR NEW.wager_transaction_id IS DISTINCT FROM OLD.wager_transaction_id
          OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
          OR (OLD.status = 'COMPENSATION_REQUIRED'
            AND NEW.status IN ('PENDING_RECOVERY', 'RECOVERED'))
        ) THEN
          RAISE EXCEPTION 'wager recovery transition is not allowed'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.status = 'COMPENSATED' AND NOT EXISTS (
          SELECT 1 FROM ${schema}.wager_transactions rb
            WHERE rb.id = NEW.compensation_transaction_id
              AND rb.kind = 'ROLLBACK'
              AND rb.status = 'PROCESSED'
              AND rb.reference_transaction_id = NEW.wager_transaction_id
        ) THEN
          RAISE EXCEPTION 'COMPENSATED requires a processed compensating ROLLBACK'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_wager_recovery
        BEFORE INSERT OR UPDATE OR DELETE ON ${schema}.wager_recoveries
        FOR EACH ROW EXECUTE FUNCTION ${schema}.validate_wager_recovery();

      CREATE TRIGGER trg_wager_recoveries_no_truncate
        BEFORE TRUNCATE ON ${schema}.wager_recoveries
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.validate_wager_recovery();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TABLE IF EXISTS wager_recoveries;
      DROP FUNCTION IF EXISTS validate_wager_recovery();
    `);
  }
}
