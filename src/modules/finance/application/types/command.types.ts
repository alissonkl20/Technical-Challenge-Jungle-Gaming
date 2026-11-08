/** Identifies the calling provider. Every query is scoped to it. */
export interface QueryScope {
  readonly id: string;
}

/** A wager as the published contract expresses it, by internal identifiers. */
export interface SubmitWagerCommand {
  readonly playerId: string;
  readonly walletId: string;
  readonly externalTransactionId: string;
  readonly kind: string;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
}
