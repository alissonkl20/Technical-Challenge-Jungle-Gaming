import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { DuplicateWalletError } from "../domain/errors.js";
import { PostgresRepository } from "./postgres.repository.js";
import type { WalletRepository, WalletRow } from "./repositories.js";

export class PostgresWalletRepository
  extends PostgresRepository
  implements WalletRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "wallets");
  }

  findById(id: string): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  findByProviderAndId(
    providerId: string,
    id: string,
  ): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = ? AND id = ?`,
      [providerId, id],
    );
  }

  findByIdForUpdate(id: string): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ? FOR UPDATE`,
      [id],
    );
  }

  findByPlayerAndCurrencyForUpdate(
    providerId: string,
    playerId: string,
    currency: string,
  ): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND player_id = ? AND currency = ?
       FOR UPDATE`,
      [providerId, playerId, currency],
    );
  }

  findByPlayerAndCurrency(
    providerId: string,
    playerId: string,
    currency: string,
  ): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND player_id = ? AND currency = ?`,
      [providerId, playerId, currency],
    );
  }

  async findAllByProviderAndPlayer(
    providerId: string,
    playerId: string,
  ): Promise<WalletRow[]> {
    return this.em.execute<WalletRow[]>(
      `SELECT * FROM ${this.tableName}
       WHERE provider_id = ? AND player_id = ?
       ORDER BY currency ASC`,
      [providerId, playerId],
    );
  }

  create(
    wallet: Pick<
      WalletRow,
      "id" | "provider_id" | "player_id" | "currency" | "balance" | "version"
    >,
  ): Promise<WalletRow> {
    return this.insertWithUniqueTranslation(
      ["id", "provider_id", "player_id", "currency", "balance", "version"],
      [
        wallet.id,
        wallet.provider_id,
        wallet.player_id,
        wallet.currency,
        wallet.balance,
        wallet.version,
      ],
      "uq_wallets_player_currency",
      () =>
        new DuplicateWalletError(
          "Player already has a wallet in this currency",
        ),
    );
  }

  updateBalance(
    id: string,
    expectedVersion: number,
    balance: string,
  ): Promise<WalletRow | null> {
    return this.findOne<WalletRow>(
      `UPDATE ${this.tableName}
       SET balance = ?, version = version + 1,
           balance_transaction_id = pg_current_xact_id(), updated_at = now()
       WHERE id = ? AND version = ? AND balance <> ?
       RETURNING *`,
      [balance, id, expectedVersion, balance],
    );
  }
}
