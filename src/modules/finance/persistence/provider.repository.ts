import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { ProviderAlreadyExistsError } from "../domain/errors.js";
import { PostgresRepository } from "./postgres.repository.js";
import type { ProviderRepository, ProviderRow } from "./repositories.js";

export class PostgresProviderRepository
  extends PostgresRepository
  implements ProviderRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "providers");
  }

  findById(id: string): Promise<ProviderRow | null> {
    return this.findOne<ProviderRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  findByIdForShare(id: string): Promise<ProviderRow | null> {
    return this.findOne<ProviderRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ? FOR SHARE`,
      [id],
    );
  }

  findByCode(code: string): Promise<ProviderRow | null> {
    return this.findOne<ProviderRow>(
      `SELECT * FROM ${this.tableName} WHERE code = ?`,
      [code],
    );
  }

  create(
    provider: Pick<ProviderRow, "id" | "code" | "name" | "status">,
  ): Promise<ProviderRow> {
    return this.insertWithUniqueTranslation(
      ["id", "code", "name", "status"],
      [provider.id, provider.code, provider.name, provider.status],
      "uq_providers_code",
      () =>
        new ProviderAlreadyExistsError(
          `Provider code "${provider.code}" already exists`,
        ),
    );
  }

  updateStatus(id: string, status: string): Promise<ProviderRow | null> {
    return this.findOne<ProviderRow>(
      `UPDATE ${this.tableName} SET status = ?, updated_at = now() WHERE id = ? RETURNING *`,
      [status, id],
    );
  }
}
