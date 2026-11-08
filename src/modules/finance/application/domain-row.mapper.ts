import { Player, Provider, Wallet } from "../domain/index.js";
import type {
  PlayerRow,
  ProviderRow,
  WalletRow,
} from "../persistence/repositories.js";

/**
 * Rehydrates aggregates from persistence rows, so the column names of these
 * three tables are mapped in one place.
 */
export function providerFromRow(row: ProviderRow): Provider {
  return Provider.rehydrate({
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
  });
}

export function playerFromRow(row: PlayerRow): Player {
  return Player.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalPlayerId: row.external_player_id,
    status: row.status,
  });
}

export function walletFromRow(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    playerId: row.player_id,
    currency: row.currency,
    balance: row.balance,
    version: row.version,
  });
}
