import { Migration } from "@mikro-orm/migrations";

/**
 * Closes the one path by which a balance could exist without a Ledger entry:
 * inserting a wallet that already carries a balance. Balance updates are
 * covered by `trg_wallet_balance_requires_ledger`; this covers the INSERT.
 *
 * A wallet created with a non-zero balance must, in the same SQL transaction,
 * receive its OPENING credit from zero to exactly that balance. The trigger is
 * deferred, so the wallet row may be written before its opening entry, which
 * is the order the application uses.
 */
export class Migration20261109100000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      CREATE FUNCTION enforce_wallet_opening_ledger() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.balance <> 0
          AND NOT EXISTS (
            SELECT 1
              FROM ${schema}.wallet_ledger_entries entry
              JOIN ${schema}.wager_transactions opening
                ON opening.id = entry.wager_transaction_id
              WHERE entry.wallet_id = NEW.id
                AND opening.kind = 'OPENING'
                AND entry.entry_type = 'CREDIT'
                AND entry.balance_before = 0
                AND entry.balance_after = NEW.balance
                AND entry.database_transaction_id = pg_current_xact_id()
          ) THEN
          RAISE EXCEPTION 'a wallet created with a balance requires its OPENING Ledger entry in the same transaction'
            USING ERRCODE = '23514';
        END IF;
        RETURN NULL;
      END;
      $$;

      CREATE CONSTRAINT TRIGGER trg_wallet_opening_requires_ledger
        AFTER INSERT ON wallets
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION enforce_wallet_opening_ledger();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_wallet_opening_requires_ledger ON wallets;
      DROP FUNCTION IF EXISTS enforce_wallet_opening_ledger();
    `);
  }
}
