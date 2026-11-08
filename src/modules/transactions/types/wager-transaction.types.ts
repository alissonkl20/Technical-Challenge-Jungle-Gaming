import type {
  FailureCode,
  Player,
  WagerTransactionKind,
  WagerTransactionSnapshot,
  WagerTransactionStatus,
  Wallet,
  WalletMovement,
  WalletSnapshot,
} from "../../finance/domain/index.js";
import type {
  PlayerRow,
  WagerTransactionRow,
  WalletRow,
} from "../../finance/persistence/repositories.js";

export interface ProcessWagerInput {
  readonly externalPlayerId: string;
  readonly externalTransactionId: string;
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly currency: string;
  readonly externalReferenceTransactionId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
  /**
   * Set by a caller that already found the request unprocessable (unknown
   * player, wallet not of the player, or currency mismatch). The rejection is
   * still recorded through the idempotency reservation, so it is auditable and
   * replayed like any other result. It is not part of the request fingerprint.
   */
  readonly rejection?: FailureCode;
}

export interface WagerProcessingResponse {
  readonly externalTransactionId: string;
  readonly status: WagerTransactionStatus;
  readonly transaction: WagerTransactionSnapshot | null;
  readonly wallet: WalletSnapshot | null;
  readonly failureCode: string | null;
}

export interface WagerProcessingResult {
  readonly httpStatus: number;
  /** True when the stored result of an earlier identical request was replayed. */
  readonly idempotentReplay: boolean;
  readonly response: WagerProcessingResponse;
}

/** A `ProcessWagerInput` after trimming and canonicalizing its values. */
export type NormalizedWagerInput = ProcessWagerInput;

export type WagerContextResult =
  | { readonly kind: "player-not-found" }
  | { readonly kind: "wallet-not-found" }
  | {
      readonly kind: "resolved";
      readonly playerRow: PlayerRow;
      readonly player: Player;
      readonly walletRow: WalletRow;
      readonly wallet: Wallet;
    };

export type WagerReferenceResolution =
  | { readonly kind: "none"; readonly transaction: null }
  | { readonly kind: "resolved"; readonly transaction: WagerTransactionRow }
  | { readonly kind: "pending"; readonly transaction: null }
  | {
      readonly kind: "rejected";
      readonly failureCode: FailureCode;
      readonly transaction: WagerTransactionRow | null;
    };

export type WagerMovementOutcome =
  | { readonly movement: WalletMovement | null; readonly failureCode: null }
  | { readonly movement: null; readonly failureCode: FailureCode };

/** The internal identifiers the published contract (HTTP and SQS) carries. */
export interface SubmittedWagerIdentity {
  readonly playerId: string;
  readonly walletId: string;
  readonly currency: string;
}

export interface ResolvedWagerIdentity {
  /** The provider-scoped player ID the wager use case works with. */
  readonly externalPlayerId: string;
  /**
   * Set when the identifiers do not describe a wallet this provider owns. The
   * wager use case records it through the idempotency reservation as a
   * REJECTED business result, so it is auditable and replayed like any other.
   */
  readonly rejection?: FailureCode;
}

/** A wager request after validation, ready for the financial transaction. */
export interface WagerRequest {
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly input: NormalizedWagerInput;
  readonly payloadHash: string;
  /** Set when the caller already refused the request; see `ProcessWagerInput`. */
  readonly preRejection?: FailureCode;
}
