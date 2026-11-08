/**
 * Machine-readable rejection taxonomy. A provider reads this code to decide
 * whether to resend, correct the payload, or escalate, so the values are
 * part of the published contract and must stay stable.
 */
export const FailureCode = {
  /** A BET could not be covered by the available balance. */
  InsufficientFunds: "INSUFFICIENT_FUNDS",
  /**
   * A REFUND or ROLLBACK would overdraw the wallet. Operationally distinct
   * from a bet without funds: the money has already left, so this needs
   * operator attention rather than a provider retry.
   */
  ReversalInsufficientFunds: "REVERSAL_INSUFFICIENT_FUNDS",
  /** Operation currency differs from the wallet currency. */
  CurrencyMismatch: "CURRENCY_MISMATCH",
  /** The movement would exceed the NUMERIC(20,2) range. */
  BalanceLimitExceeded: "BALANCE_LIMIT_EXCEEDED",
  /** The referenced transaction never arrived within the TTL. */
  ReferenceNotFound: "REFERENCE_NOT_FOUND",
  /** The reference exists but is not PROCESSED. */
  ReferenceNotProcessed: "REFERENCE_NOT_PROCESSED",
  /** The reference belongs to another player, wallet, or currency. */
  ReferenceContextMismatch: "REFERENCE_CONTEXT_MISMATCH",
  /** The reference belongs to another round. */
  ReferenceRoundMismatch: "REFERENCE_ROUND_MISMATCH",
  /** Partial reversal, which is out of scope. */
  ReferenceAmountMismatch: "REFERENCE_AMOUNT_MISMATCH",
  /** REFUND targeting a non-BET, or an ineligible ROLLBACK target. */
  ReferenceKindNotEligible: "REFERENCE_KIND_NOT_ELIGIBLE",
  /** The target already has a processed reversal. */
  ReferenceAlreadyReversed: "REFERENCE_ALREADY_REVERSED",
  /**
   * The BET already has an active result (WIN, LOSS or REFUND), processed or
   * reserved while waiting for the BET. The first valid result recorded wins;
   * a WIN reversed by ROLLBACK no longer holds the result.
   */
  ReferenceAlreadySettled: "REFERENCE_ALREADY_SETTLED",
  /** ROLLBACK of a REFUND whose original BET is not a valid chain. */
  ReferenceChainInvalid: "REFERENCE_CHAIN_INVALID",
  /**
   * The stored context of a pending operation is inconsistent, so it can never
   * be resumed. Used with FAILED, which is an operator-facing terminal state.
   */
  InternalInconsistency: "INTERNAL_INCONSISTENCY",
  /** The provider is not authorized to move money. */
  ProviderInactive: "PROVIDER_INACTIVE",
  /** The player is not authorized to move money. */
  PlayerInactive: "PLAYER_INACTIVE",
  /** The submitted player does not exist for this provider. */
  PlayerNotFound: "PLAYER_NOT_FOUND",
  /** The submitted wallet does not exist for this player. */
  WalletNotFound: "WALLET_NOT_FOUND",
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

const FAILURE_CODES = new Set<string>(Object.values(FailureCode));

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}
