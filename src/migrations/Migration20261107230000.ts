import { Migration } from "@mikro-orm/migrations";

export class Migration20261107230000 extends Migration {
  override up(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    this.addSql(`
      CREATE INDEX ix_wallet_ledger_provider_player_cursor
        ON "${schemaName}".wallet_ledger_entries
          (provider_id, player_id, created_at DESC, id DESC);
    `);
  }

  override down(): void {
    const schemaName = this.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }
    this.addSql(`
      DROP INDEX IF EXISTS "${schemaName}".ix_wallet_ledger_provider_player_cursor;
    `);
  }
}
