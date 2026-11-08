import { Migration } from "@mikro-orm/migrations";

/**
 * Settlement rules for WIN and REFUND, enforced by PostgreSQL.
 *
 * Policy (conservative, documented in ARCHITECTURE.md). These rules apply to a
 * WIN that references a BET. A WIN without a reference is an uncorrelated
 * credit, unique only by its external transaction ID:
 * - A BET has at most one ACTIVE WIN. A WIN is active while it is PROCESSED
 *   and has no PROCESSED ROLLBACK targeting it. A rolled-back WIN therefore
 *   does not block a corrected WIN.
 * - A WIN cannot be processed against a reference that already has a
 *   PROCESSED REFUND or ROLLBACK.
 * - REFUND against a BET that has an ACTIVE WIN is NOT blocked here. The
 *   existing contract tests specify it as valid; whether it should be is an
 *   open product decision, recorded in ARCHITECTURE.md.
 *
 * Each trigger locks the reference row FOR UPDATE, the same serialization the
 * reversal trigger uses, so concurrent settlements of one BET are ordered by
 * PostgreSQL even if the application check is bypassed.
 */
export class Migration20261108100000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      CREATE FUNCTION ${schema}.validate_processed_win_settlement() RETURNS trigger
      LANGUAGE plpgsql AS $$
      DECLARE
        target ${schema}.wager_transactions%ROWTYPE;
      BEGIN
        IF NEW.status <> 'PROCESSED' OR NEW.kind <> 'WIN' THEN
          RETURN NEW;
        END IF;

        -- A WIN without a reference is an uncorrelated credit allowed by the
        -- contract. Its uniqueness comes from the provider external ID and the
        -- idempotency key, not from a BET, so there is nothing to settle here.
        IF NEW.reference_transaction_id IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT * INTO target
          FROM ${schema}.wager_transactions
          WHERE id = NEW.reference_transaction_id
          FOR UPDATE;

        IF NOT FOUND OR target.kind <> 'BET' OR target.status <> 'PROCESSED' THEN
          RAISE EXCEPTION 'processed WIN must reference a processed BET'
            USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
          SELECT 1 FROM ${schema}.wager_transactions r
            WHERE r.reference_transaction_id = target.id
              AND r.kind IN ('REFUND', 'ROLLBACK')
              AND r.status = 'PROCESSED'
        ) THEN
          RAISE EXCEPTION 'WIN cannot settle a reversed BET'
            USING ERRCODE = '23514',
              CONSTRAINT = 'ck_wager_win_reference_not_reversed';
        END IF;

        IF EXISTS (
          SELECT 1 FROM ${schema}.wager_transactions w
            WHERE w.reference_transaction_id = target.id
              AND w.kind = 'WIN'
              AND w.status = 'PROCESSED'
              AND w.id <> NEW.id
              AND NOT EXISTS (
                SELECT 1 FROM ${schema}.wager_transactions rb
                  WHERE rb.reference_transaction_id = w.id
                    AND rb.kind = 'ROLLBACK'
                    AND rb.status = 'PROCESSED'
              )
        ) THEN
          RAISE EXCEPTION 'BET already has an active WIN'
            USING ERRCODE = '23505',
              CONSTRAINT = 'uq_wager_active_win_per_bet';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_processed_win_settlement
        BEFORE INSERT OR UPDATE OF status, kind, reference_transaction_id
        ON ${schema}.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION ${schema}.validate_processed_win_settlement();

    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_validate_processed_win_settlement ON wager_transactions;
      DROP FUNCTION IF EXISTS validate_processed_win_settlement();
    `);
  }
}
