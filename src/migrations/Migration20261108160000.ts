import { Migration } from "@mikro-orm/migrations";

/**
 * Aligns the reference CHECKs with the challenge contract: only REFUND and
 * ROLLBACK must carry `external_reference_transaction_id`; WIN and LOSS may
 * reference the BET they settle or be recorded on their own; BET and OPENING
 * carry none. A PROCESSED operation that does name a reference must have
 * resolved it to an internal transaction.
 *
 * The one-result-per-BET trigger is unchanged: it only binds results that
 * name a BET, so an uncorrelated WIN or LOSS never competes for a BET.
 */
export class Migration20261108160000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      ALTER TABLE ${schema}.wager_transactions
        DROP CONSTRAINT ck_wager_transactions_reference_by_kind,
        DROP CONSTRAINT ck_wager_transactions_processed_result_reference;

      ALTER TABLE ${schema}.wager_transactions
        ADD CONSTRAINT ck_wager_transactions_reference_by_kind
          CHECK (
            (kind IN ('REFUND', 'ROLLBACK')
              AND external_reference_transaction_id IS NOT NULL)
            OR kind IN ('WIN', 'LOSS')
            OR (kind IN ('OPENING', 'BET')
              AND external_reference_transaction_id IS NULL)
          ) NOT VALID,
        ADD CONSTRAINT ck_wager_transactions_processed_result_reference
          CHECK (
            status <> 'PROCESSED'
            OR external_reference_transaction_id IS NULL
            OR reference_transaction_id IS NOT NULL
          ) NOT VALID;
    `);
  }

  override down(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      ALTER TABLE ${schema}.wager_transactions
        DROP CONSTRAINT ck_wager_transactions_reference_by_kind,
        DROP CONSTRAINT ck_wager_transactions_processed_result_reference;

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
    `);
  }
}
