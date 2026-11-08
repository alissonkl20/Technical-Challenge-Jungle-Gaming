import { Migration } from "@mikro-orm/migrations";

/**
 * Keeps the correlation ID of the flow that first submitted a financial
 * operation. A pending reference resumed by a worker reuses it, so the events
 * produced later stay linked to the original request.
 */
export class Migration20261108120000 extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE financial_operations
        ADD COLUMN correlation_id varchar(128) NULL,
        ADD CONSTRAINT ck_financial_operations_correlation_id
          CHECK (correlation_id IS NULL OR correlation_id ~ '^[A-Za-z0-9._:-]{1,128}$');
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE financial_operations
        DROP CONSTRAINT IF EXISTS ck_financial_operations_correlation_id,
        DROP COLUMN IF EXISTS correlation_id;
    `);
  }
}
