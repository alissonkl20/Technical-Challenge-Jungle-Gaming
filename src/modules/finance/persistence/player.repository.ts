import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { DuplicatePlayerError } from "../domain/errors.js";
import { PostgresRepository } from "./postgres.repository.js";
import type { PlayerRepository, PlayerRow } from "./repositories.js";

export class PostgresPlayerRepository
  extends PostgresRepository
  implements PlayerRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "players");
  }

  findById(id: string): Promise<PlayerRow | null> {
    return this.findOne<PlayerRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  findByProviderAndExternalId(
    providerId: string,
    externalPlayerId: string,
  ): Promise<PlayerRow | null> {
    return this.findOne<PlayerRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = ? AND external_player_id = ?`,
      [providerId, externalPlayerId],
    );
  }

  findByProviderAndExternalIdForShare(
    providerId: string,
    externalPlayerId: string,
  ): Promise<PlayerRow | null> {
    return this.findOne<PlayerRow>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND external_player_id = ?
       FOR SHARE`,
      [providerId, externalPlayerId],
    );
  }

  create(
    player: Pick<
      PlayerRow,
      "id" | "provider_id" | "external_player_id" | "status"
    >,
  ): Promise<PlayerRow> {
    return this.insertWithUniqueTranslation(
      ["id", "provider_id", "external_player_id", "status"],
      [player.id, player.provider_id, player.external_player_id, player.status],
      "uq_players_provider_external_id",
      () =>
        new DuplicatePlayerError(
          `Player "${player.external_player_id}" already exists for this provider`,
        ),
    );
  }

  updateStatus(
    providerId: string,
    playerId: string,
    status: string,
  ): Promise<PlayerRow | null> {
    return this.findOne<PlayerRow>(
      `UPDATE ${this.tableName}
       SET status = ?, updated_at = now()
       WHERE provider_id = ? AND id = ?
       RETURNING *`,
      [status, providerId, playerId],
    );
  }
}
