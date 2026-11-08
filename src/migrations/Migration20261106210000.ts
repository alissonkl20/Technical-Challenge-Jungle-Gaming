import { Migration } from "@mikro-orm/migrations";

export class Migration20261106210000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      CREATE FUNCTION reject_terminal_wager_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          RAISE EXCEPTION 'terminal wager transactions are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_terminal_wager_immutable
        BEFORE UPDATE OR DELETE ON ${schema}.wager_transactions
        FOR EACH ROW EXECUTE FUNCTION reject_terminal_wager_mutation();

      CREATE FUNCTION reject_completed_financial_operation_mutation()
        RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.completed_at IS NOT NULL THEN
          RAISE EXCEPTION 'completed financial operations are immutable'
            USING ERRCODE = '55000';
        END IF;
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_completed_financial_operation_immutable
        BEFORE UPDATE OR DELETE ON ${schema}.financial_operations
        FOR EACH ROW
        EXECUTE FUNCTION reject_completed_financial_operation_mutation();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_completed_financial_operation_immutable
        ON financial_operations;
      DROP FUNCTION IF EXISTS reject_completed_financial_operation_mutation();
      DROP TRIGGER IF EXISTS trg_terminal_wager_immutable
        ON wager_transactions;
      DROP FUNCTION IF EXISTS reject_terminal_wager_mutation();
    `);
  }
}
