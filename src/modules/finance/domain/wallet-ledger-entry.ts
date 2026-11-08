import { InvalidLedgerEntryError } from "./errors.js";
import { Money } from "./money.js";
import {
  type LedgerEntryId,
  ledgerEntryId,
  type WagerTransactionId,
  type WalletId,
  wagerTransactionId,
  walletId,
} from "./types.js";

export const LedgerDirection = {
  Debit: "DEBIT",
  Credit: "CREDIT",
} as const;

export type LedgerDirection =
  (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt?: Date;
}

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: Date | string;
}

export interface LedgerEntrySnapshot {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: string;
  readonly currency: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly createdAt: string;
}

/**
 * An immutable ledger line. There are no setters and no transitions: the
 * immutability is structural, not a convention. `create` verifies the
 * arithmetic of the movement, so an unbalanced entry cannot be built.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: LedgerEntryId,
    readonly walletId: WalletId,
    readonly transactionId: WagerTransactionId,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      ledgerEntryId(props.id),
      walletId(props.walletId),
      wagerTransactionId(props.transactionId),
      assertDirection(props.direction),
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt ?? new Date(),
    );
    entry.assertConsistent();
    return entry;
  }

  /** Reconstruction from persistence: does not revalidate domain transitions. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    const createdAt = new Date(state.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      throw new InvalidLedgerEntryError(
        "Ledger entry createdAt must be a valid timestamp",
      );
    }

    return new WalletLedgerEntry(
      ledgerEntryId(state.id),
      walletId(state.walletId),
      wagerTransactionId(state.transactionId),
      assertDirection(state.direction),
      Money.fromDecimal(state.amount, state.currency),
      Money.fromDecimal(state.balanceBefore, state.currency),
      Money.fromDecimal(state.balanceAfter, state.currency),
      createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter`. Verified by the factory. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  snapshot(): LedgerEntrySnapshot {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      amount: this.money.toDecimal(),
      currency: this.money.currency,
      balanceBefore: this.balanceBefore.toDecimal(),
      balanceAfter: this.balanceAfter.toDecimal(),
      createdAt: this.createdAt.toISOString(),
    };
  }

  private assertConsistent(): void {
    if (!this.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        "Ledger entry amount must be greater than zero",
      );
    }
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      throw new InvalidLedgerEntryError(
        "Ledger entry amount and balances must share one currency",
      );
    }
    if (this.balanceBefore.isNegative() || this.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(
        "Ledger entry balances cannot be negative",
      );
    }
    if (!this.isBalanced()) {
      throw new InvalidLedgerEntryError(
        "Ledger entry arithmetic does not match its balances",
      );
    }
  }
}

/**
 * What an applied wallet movement produces: the pairing of the new balance
 * with its ledger line. The aggregate returns both together, so a balance
 * change without a matching entry cannot be expressed in code.
 */
export class WalletMovement {
  private constructor(
    readonly entry: WalletLedgerEntry,
    readonly version: number,
  ) {
    Object.freeze(this);
  }

  static of(props: {
    readonly entry: WalletLedgerEntry;
    readonly version: number;
  }): WalletMovement {
    return new WalletMovement(props.entry, props.version);
  }

  get direction(): LedgerDirection {
    return this.entry.direction;
  }

  get money(): Money {
    return this.entry.money;
  }

  get balanceBefore(): Money {
    return this.entry.balanceBefore;
  }

  get balanceAfter(): Money {
    return this.entry.balanceAfter;
  }
}

function assertDirection(value: LedgerDirection): LedgerDirection {
  if (value !== LedgerDirection.Credit && value !== LedgerDirection.Debit) {
    throw new InvalidLedgerEntryError("Unknown ledger direction");
  }
  return value;
}
