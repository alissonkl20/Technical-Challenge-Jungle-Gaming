import { FailureCode } from "./failure-code.js";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "./wager-transaction.js";

/** The wallet context an operation and its reference must both belong to. */
export interface ReferenceContext {
  readonly playerId: string;
  readonly walletId: string;
  readonly currency: string;
  readonly roundId?: string;
}

export type ReferenceDecision =
  /** The operation does not point at another transaction. */
  | { readonly kind: "not-required" }
  /** The referenced transaction is not usable yet; retry later. */
  | { readonly kind: "pending" }
  /** Context, state, kind, round and amount all check out. */
  | { readonly kind: "eligible" }
  | { readonly kind: "rejected"; readonly failureCode: FailureCode };

/**
 * Which kinds an operation may reverse or point at.
 *
 * WIN, LOSS and REFUND are results of a BET. ROLLBACK reverses a BET, a WIN
 * or a REFUND.
 */
export function isEligibleReferenceKind(
  wagerKind: WagerTransactionKind,
  referenceKind: WagerTransactionKind,
): boolean {
  switch (wagerKind) {
    case WagerTransactionKind.WIN:
    case WagerTransactionKind.LOSS:
    case WagerTransactionKind.REFUND:
      return referenceKind === WagerTransactionKind.BET;
    case WagerTransactionKind.ROLLBACK:
      return (
        referenceKind === WagerTransactionKind.BET ||
        referenceKind === WagerTransactionKind.WIN ||
        referenceKind === WagerTransactionKind.REFUND
      );
    default:
      return false;
  }
}

/**
 * Pure reference rule. It receives domain objects, never persistence rows, so
 * it is decided and tested without a database. The two checks that need a
 * query — whether the target was already reversed, and whether a
 * ROLLBACK-of-REFUND chain is intact — stay in the application layer, which
 * runs them only once this decision is `eligible`.
 */
export function evaluateWagerReference(
  wager: WagerTransaction,
  reference: WagerTransaction | null,
  context: ReferenceContext,
): ReferenceDecision {
  if (wager.externalReferenceTransactionId === undefined) {
    return { kind: "not-required" };
  }
  if (reference === null) {
    return { kind: "pending" };
  }

  if (
    reference.playerId !== context.playerId ||
    reference.walletId !== context.walletId ||
    reference.currency !== context.currency
  ) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceContextMismatch,
    };
  }

  if (reference.status !== WagerTransactionStatus.PROCESSED) {
    if (
      reference.status === WagerTransactionStatus.PENDING ||
      reference.status === WagerTransactionStatus.PENDING_REFERENCE
    ) {
      return { kind: "pending" };
    }
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceNotProcessed,
    };
  }

  if (!isEligibleReferenceKind(wager.kind, reference.kind)) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceKindNotEligible,
    };
  }

  if (reference.roundId !== context.roundId) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceRoundMismatch,
    };
  }

  // Partial reversal is out of scope: the amounts must match exactly.
  if (wager.isReversal() && !reference.amount.equals(wager.amount)) {
    return {
      kind: "rejected",
      failureCode: FailureCode.ReferenceAmountMismatch,
    };
  }

  return { kind: "eligible" };
}
