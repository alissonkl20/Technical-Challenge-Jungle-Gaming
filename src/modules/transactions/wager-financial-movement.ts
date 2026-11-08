import { randomUUID } from "node:crypto";
import {
  CurrencyMismatchError,
  FailureCode,
  InsufficientFundsError,
  InvalidMoneyError,
  LedgerDirection,
  type WagerTransaction,
  type Wallet,
} from "../finance/domain/index.js";
import type { WagerMovementOutcome } from "./types/index.js";

/**
 * Asks the transaction which direction it moves, then applies it to the
 * aggregate. The aggregate returns balance and ledger entry together, so this
 * layer only translates domain errors into the provider-facing failure code.
 */
export function applyWagerMovement(
  wager: WagerTransaction,
  wallet: Wallet,
  referenceKind?: WagerTransaction["kind"],
): WagerMovementOutcome {
  const direction = wager.ledgerDirectionFor(referenceKind);
  if (direction === null) {
    return { movement: null, failureCode: null };
  }

  const request = {
    entryId: randomUUID(),
    transactionId: wager.id,
    money: wager.amount,
  };

  try {
    const movement =
      direction === LedgerDirection.Credit
        ? wallet.credit(request)
        : wallet.debit(request);
    return { movement, failureCode: null };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // A reversal that would overdraw the wallet is operationally different
      // from a bet placed without funds, so providers get a distinct code.
      return {
        movement: null,
        failureCode: wager.isReversal()
          ? FailureCode.ReversalInsufficientFunds
          : FailureCode.InsufficientFunds,
      };
    }
    if (error instanceof CurrencyMismatchError) {
      return { movement: null, failureCode: FailureCode.CurrencyMismatch };
    }
    if (error instanceof InvalidMoneyError) {
      return {
        movement: null,
        failureCode: FailureCode.BalanceLimitExceeded,
      };
    }

    throw error;
  }
}
