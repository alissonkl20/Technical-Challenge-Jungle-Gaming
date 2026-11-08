import { Migration } from "@mikro-orm/migrations";

/**
 * One definitive result per BET, enforced by PostgreSQL.
 *
 * WIN, LOSS and REFUND are results of a BET and each names it through
 * `external_reference_transaction_id`. The first valid result recorded wins:
 * a result that is processed, or still waiting for its BET
 * (PENDING / PENDING_REFERENCE), holds the slot, so a conflicting result is
 * refused whether the BET arrived before or after it. A WIN reversed by a
 * processed ROLLBACK releases the slot (the established "corrected WIN" rule).
 *
 * The slot cannot be a partial unique index, because "not reversed by a
 * ROLLBACK" depends on another row. The trigger therefore locks the wallet row
 * FOR UPDATE first, the same lock every application path takes before any
 * transaction row, which serializes all results of the BET (they share the
 * wallet) even for direct SQL. Each statement in the volatile function then
 * reads a fresh snapshot, so it sees a competitor that committed while it
 * waited.
 *
 * The CHECKs make WIN, LOSS, REFUND and ROLLBACK carry a reference and BET
 * carry none, and a PROCESSED one resolve it to an internal transaction. It is NOT VALID so it binds every new or updated row without
 * failing on rows written under the previous contract (WIN without reference).
 */
export class Migration20261108140000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      ALTER TABLE ${schema}.wager_transactions
        ADD CONSTRAINT ck_wager_transactions_reference_by_kind
          CHECK (
            (kind IN ('WIN', 'LOSS', 'REFUND', 'ROLLBACK')
              AND external_reference_transaction_id IS NOT NULL)
            OR (kind IN ('OPENING', 'BET')
              AND external_reference_transaction_id IS NULL)
          ) NOT VALID,
        ADD CONSTRAINT ck_wager_transactions_processed_result_reference
          CHECK (
            kind NOT IN ('WIN', 'LOSS', 'REFUND', 'ROLLBACK')
            OR status <> 'PROCESSED'
            OR reference_transaction_id IS NOT NULL
          ) NOT VALID;

      CREATE FUNCTION ${schema}.validate_bet_result_slot() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind NOT IN ('WIN', 'LOSS', 'REFUND')
          OR NEW.status NOT IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED') THEN
          RETURN NEW;
        END IF;

        PERFORM 1 FROM ${schema}.wallets WHERE id = NEW.wallet_id FOR UPDATE;

        IF EXISTS (
          SELECT 1 FROM ${schema}.wager_transactions r
            WHERE r.provider_id = NEW.provider_id
              AND r.wallet_id = NEW.wallet_id
              AND r.external_reference_transaction_id
                = NEW.external_reference_transaction_id
              AND r.kind IN ('WIN', 'LOSS', 'REFUND')
              AND r.status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED')
              AND r.id <> NEW.id
              AND NOT EXISTS (
                SELECT 1 FROM ${schema}.wager_transactions rb
                  WHERE rb.reference_transaction_id = r.id
                    AND rb.kind = 'ROLLBACK'
                    AND rb.status = 'PROCESSED'
              )
        ) THEN
          RAISE EXCEPTION 'BET already has an active result'
            USING ERRCODE = '23505',
              CONSTRAINT = 'uq_wager_result_per_bet';
        END IF;

        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_validate_bet_result_slot
        BEFORE INSERT OR UPDATE OF status, kind, external_reference_transaction_id
        ON ${schema}.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION ${schema}.validate_bet_result_slot();

      CREATE INDEX ix_wager_transactions_bet_result
        ON ${schema}.wager_transactions
          (provider_id, wallet_id, external_reference_transaction_id)
        WHERE kind IN ('WIN', 'LOSS', 'REFUND');
    `);
  }

  override down(): void {
    this.addSql(`
      DROP INDEX IF EXISTS ix_wager_transactions_bet_result;
      DROP TRIGGER IF EXISTS trg_validate_bet_result_slot ON wager_transactions;
      DROP FUNCTION IF EXISTS validate_bet_result_slot();
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS ck_wager_transactions_processed_result_reference,
        DROP CONSTRAINT IF EXISTS ck_wager_transactions_reference_by_kind;
    `);
  }
}
