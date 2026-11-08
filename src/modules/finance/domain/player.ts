import { DomainError } from "./errors.js";
import {
  type PlayerId,
  type ProviderId,
  playerId,
  providerId,
} from "./types.js";

export const PlayerStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export type PlayerStatus = (typeof PlayerStatus)[keyof typeof PlayerStatus];

export interface PlayerSnapshot {
  readonly id: string;
  readonly providerId: string;
  readonly externalPlayerId: string;
  readonly status: string;
}

function externalId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new DomainError(
      "externalPlayerId must contain between 1 and 200 characters",
    );
  }
  return normalized;
}

function status(value: string): PlayerStatus {
  if (value !== PlayerStatus.ACTIVE && value !== PlayerStatus.SUSPENDED) {
    throw new DomainError(`Invalid player status: ${value}`);
  }
  return value;
}

export class Player {
  private constructor(
    readonly id: PlayerId,
    readonly providerId: ProviderId,
    readonly externalPlayerId: string,
    private statusValue: PlayerStatus,
  ) {}

  static register(input: {
    readonly id: string;
    readonly providerId: string;
    readonly externalPlayerId: string;
  }): Player {
    return new Player(
      playerId(input.id),
      providerId(input.providerId),
      externalId(input.externalPlayerId),
      PlayerStatus.ACTIVE,
    );
  }

  static rehydrate(snapshot: PlayerSnapshot): Player {
    return new Player(
      playerId(snapshot.id),
      providerId(snapshot.providerId),
      externalId(snapshot.externalPlayerId),
      status(snapshot.status),
    );
  }

  get status(): PlayerStatus {
    return this.statusValue;
  }

  setStatus(value: string): void {
    this.statusValue = status(value);
  }

  activate(): void {
    this.setStatus(PlayerStatus.ACTIVE);
  }

  suspend(): void {
    this.setStatus(PlayerStatus.SUSPENDED);
  }

  snapshot(): PlayerSnapshot {
    return {
      id: this.id,
      providerId: this.providerId,
      externalPlayerId: this.externalPlayerId,
      status: this.statusValue,
    };
  }
}
