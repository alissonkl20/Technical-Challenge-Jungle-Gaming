import {
  playerFromRow,
  walletFromRow,
} from "../finance/application/domain-row.mapper.js";
import type { Provider } from "../finance/domain/index.js";
import type { PersistenceSession } from "../finance/persistence/repositories.js";
import type { WagerContextResult } from "./types/index.js";

/**
 * Locks the player (share) and then the wallet (update), in the order every
 * settlement path follows.
 */
export async function loadWagerContext(
  session: PersistenceSession,
  provider: Provider,
  externalPlayerId: string,
  currency: string,
): Promise<WagerContextResult> {
  const playerRow = await session.players.findByProviderAndExternalIdForShare(
    provider.id,
    externalPlayerId,
  );
  if (playerRow === null) {
    return { kind: "player-not-found" };
  }

  const player = playerFromRow(playerRow);
  const walletRow = await session.wallets.findByPlayerAndCurrencyForUpdate(
    provider.id,
    player.id,
    currency,
  );
  if (walletRow === null) {
    return { kind: "wallet-not-found" };
  }

  return {
    kind: "resolved",
    playerRow,
    player,
    walletRow,
    wallet: walletFromRow(walletRow),
  };
}
