import { Migration } from "@mikro-orm/migrations";

/**
 * Two database guarantees that were previously held only by the application.
 *
 * 1. A provider external transaction ID identifies at most one wager
 *    transaction. Until now this was implied by `financial_operations`
 *    (UNIQUE provider + external ID) plus application code copying the same
 *    value into `wager_transactions`. Reference resolution reads
 *    `wager_transactions` by (provider_id, external_transaction_id), so the
 *    uniqueness it depends on now lives on that table too.
 *
 * 2. An Outbox event's identity and payload are immutable, and events are
 *    never deleted. The Outbox is append-only and is the audit trail of every
 *    decision taken on a transaction (PendingReference, Processed, Rejected,
 *    WalletBalanceChanged). Only the delivery columns (status, attempts, lease,
 *    errors, timestamps) may change.
 */
export class Migration20261108130000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    const schema = `"${schemaName}"`;

    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_transactions_provider_external_id
        ON ${schema}.wager_transactions (provider_id, external_transaction_id)
        WHERE external_transaction_id IS NOT NULL;

      CREATE FUNCTION ${schema}.reject_outbox_event_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
          RAISE EXCEPTION 'outbox events are append-only'
            USING ERRCODE = '55000';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
          OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
          OR NEW.event_type IS DISTINCT FROM OLD.event_type
          OR NEW.payload IS DISTINCT FROM OLD.payload
          OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'outbox event identity and payload are immutable'
            USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER trg_outbox_event_immutable
        BEFORE UPDATE OR DELETE ON ${schema}.outbox
        FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_outbox_event_mutation();

      CREATE TRIGGER trg_outbox_no_truncate
        BEFORE TRUNCATE ON ${schema}.outbox
        FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.reject_outbox_event_mutation();
    `);
  }

  override down(): void {
    this.addSql(`
      DROP TRIGGER IF EXISTS trg_outbox_no_truncate ON outbox;
      DROP TRIGGER IF EXISTS trg_outbox_event_immutable ON outbox;
      DROP FUNCTION IF EXISTS reject_outbox_event_mutation();
      DROP INDEX IF EXISTS uq_wager_transactions_provider_external_id;
    `);
  }
}
