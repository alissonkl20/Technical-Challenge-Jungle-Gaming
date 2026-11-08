import {
  FailureCode,
  IdempotencyConflictError,
} from "../finance/domain/index.js";
import type { PersistenceSession } from "../finance/persistence/repositories.js";
import type {
  ResolvedWagerIdentity,
  SubmittedWagerIdentity,
  WagerProcessingResult,
} from "./types/index.js";

/**
 * Resolves `playerId` and `walletId` inside the caller's SQL transaction.
 *
 * HTTP and SQS both call this, so an unknown player, a wallet of another
 * player, or a currency mismatch is the same business rejection on either
 * channel. Every lookup is scoped by the provider: a player or wallet of
 * another provider is indistinguishable from one that does not exist.
 */
export async function resolveSubmittedWagerIdentity(
  session: PersistenceSession,
  providerId: string,
  identity: SubmittedWagerIdentity,
): Promise<ResolvedWagerIdentity> {
  const player = await session.players.findById(identity.playerId);
  if (player === null || player.provider_id !== providerId) {
    return {
      externalPlayerId: identity.playerId,
      rejection: FailureCode.PlayerNotFound,
    };
  }
  const wallet = await session.wallets.findByProviderAndId(
    providerId,
    identity.walletId,
  );
  if (wallet === null || wallet.player_id !== player.id) {
    return {
      externalPlayerId: player.external_player_id,
      rejection: FailureCode.WalletNotFound,
    };
  }
  if (wallet.currency !== identity.currency) {
    return {
      externalPlayerId: player.external_player_id,
      rejection: FailureCode.CurrencyMismatch,
    };
  }
  return { externalPlayerId: player.external_player_id };
}

/**
 * `walletId` is not part of the payload fingerprint: the wager use case is
 * shared with channels that address a wallet by player and currency, and the
 * pending-reference worker must reproduce the original fingerprint. A wallet
 * is unique per player and currency, both of which are fingerprinted, so the
 * only way a replay can name another wallet is a request that reused the key
 * with a different `walletId`. That is a different payload, so it is refused
 * as a conflict instead of being served the stored response.
 */
export function assertReplayAddressesWallet(
  result: WagerProcessingResult,
  idempotencyKey: string,
  walletId: string,
): void {
  const storedWalletId = result.response.wallet?.id;
  if (
    result.idempotentReplay &&
    storedWalletId !== undefined &&
    storedWalletId !== walletId
  ) {
    throw new IdempotencyConflictError(
      idempotencyKey,
      `walletId:${storedWalletId}`,
      `walletId:${walletId}`,
    );
  }
}
