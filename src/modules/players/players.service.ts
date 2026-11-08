import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { playerFromRow } from "../finance/application/domain-row.mapper.js";
import {
  playerId as asPlayerId,
  providerId as asProviderId,
  DuplicatePlayerError,
  InactiveProviderError,
  Player,
  PlayerNotFoundError,
  ProviderNotFoundError,
  ProviderStatus,
} from "../finance/domain/index.js";
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from "../finance/persistence/index.js";
import type { RegisterPlayerInput } from "./types/index.js";

@Injectable()
export class PlayersService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
  ) {}

  register(providerId: string, input: RegisterPlayerInput): Promise<Player> {
    const player = Player.register({
      id: randomUUID(),
      providerId,
      externalPlayerId: input.externalPlayerId,
    });

    return this.transactions.transaction(async ({ providers, players }) => {
      const provider = await providers.findById(providerId);
      if (!provider) {
        throw new ProviderNotFoundError(
          `Provider "${providerId}" was not found`,
        );
      }
      if (provider.status !== ProviderStatus.ACTIVE) {
        throw new InactiveProviderError(`Provider "${providerId}" is inactive`);
      }

      const existing = await players.findByProviderAndExternalId(
        providerId,
        player.externalPlayerId,
      );
      if (existing) {
        throw new DuplicatePlayerError(
          `Player "${player.externalPlayerId}" already exists for this provider`,
        );
      }

      const snapshot = player.snapshot();
      return playerFromRow(
        await players.create({
          id: snapshot.id,
          provider_id: snapshot.providerId,
          external_player_id: snapshot.externalPlayerId,
          status: snapshot.status,
        }),
      );
    });
  }

  findByExternalId(
    providerId: string,
    externalPlayerId: string,
  ): Promise<Player> {
    const validatedProviderId = asProviderId(providerId);
    return this.transactions.transaction(async ({ providers, players }) => {
      if (!(await providers.findById(validatedProviderId))) {
        throw new ProviderNotFoundError(
          `Provider "${validatedProviderId}" was not found`,
        );
      }

      const row = await players.findByProviderAndExternalId(
        validatedProviderId,
        externalPlayerId,
      );
      if (!row) {
        throw new PlayerNotFoundError(
          `Player "${externalPlayerId}" was not found for this provider`,
        );
      }
      return playerFromRow(row);
    });
  }

  setStatus(
    providerId: string,
    playerId: string,
    requestedStatus: string,
  ): Promise<Player> {
    const validatedProviderId = asProviderId(providerId);
    const validatedPlayerId = asPlayerId(playerId);
    return this.transactions.transaction(async ({ providers, players }) => {
      if (!(await providers.findById(validatedProviderId))) {
        throw new ProviderNotFoundError(
          `Provider "${validatedProviderId}" was not found`,
        );
      }

      const existing = await players.findById(validatedPlayerId);
      if (!existing || existing.provider_id !== validatedProviderId) {
        throw new PlayerNotFoundError(
          `Player "${validatedPlayerId}" was not found`,
        );
      }
      const player = playerFromRow(existing);
      player.setStatus(requestedStatus);

      const updated = await players.updateStatus(
        validatedProviderId,
        validatedPlayerId,
        player.status,
      );
      if (!updated) {
        throw new PlayerNotFoundError(
          `Player "${validatedPlayerId}" was not found`,
        );
      }
      return playerFromRow(updated);
    });
  }
}
