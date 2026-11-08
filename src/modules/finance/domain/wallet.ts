import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletError,
} from "./errors.js";
import { Money } from "./money.js";
import {
  type CurrencyCode,
  currencyCode,
  type PlayerId,
  type ProviderId,
  playerId,
  providerId,
  type WalletId,
  walletId,
} from "./types.js";
import {
  LedgerDirection,
  WalletLedgerEntry,
  WalletMovement,
} from "./wallet-ledger-entry.js";

export interface OpenWalletInput {
  readonly id: string;
  readonly providerId: string;
  readonly playerId: string;
  readonly currency: string;
}

export interface WalletSnapshot extends OpenWalletInput {
  readonly balance: string;
  readonly version: number;
}

/**
 * A movement request. The caller supplies the identity of the ledger line and
 * of the transaction that causes it, so the aggregate stays free of clocks and
 * ID generators.
 */
export interface WalletMovementRequest {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly occurredAt?: Date;
}

export class Wallet {
  private balanceValue: Money;
  private versionValue: number;

  private constructor(
    readonly id: WalletId,
    readonly providerId: ProviderId,
    readonly playerId: PlayerId,
    readonly currency: CurrencyCode,
    balance: Money,
    version: number,
  ) {
    this.balanceValue = balance;
    this.versionValue = version;
  }

  static open(input: OpenWalletInput): Wallet {
    const currency = currencyCode(input.currency);
    return new Wallet(
      walletId(input.id),
      providerId(input.providerId),
      playerId(input.playerId),
      currency,
      Money.zero(currency),
      1,
    );
  }

  static rehydrate(snapshot: WalletSnapshot): Wallet {
    if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
      throw new InvalidWalletError("Wallet version must be a positive integer");
    }

    const currency = currencyCode(snapshot.currency);
    const balance = Money.fromDecimal(snapshot.balance, currency);
    if (balance.isNegative()) {
      throw new InvalidWalletError("Wallet balance cannot be negative");
    }

    return new Wallet(
      walletId(snapshot.id),
      providerId(snapshot.providerId),
      playerId(snapshot.playerId),
      currency,
      balance,
      snapshot.version,
    );
  }

  get balance(): Money {
    return this.balanceValue;
  }

  get version(): number {
    return this.versionValue;
  }

  /**
   * Applies a credit and returns the movement it produced. Balance and ledger
   * line are produced together: there is no way to change the balance without
   * also obtaining the entry that justifies it.
   */
  credit(request: WalletMovementRequest): WalletMovement {
    return this.apply(request, LedgerDirection.Credit);
  }

  /** Applies a debit. Rejects a movement the balance cannot cover. */
  debit(request: WalletMovementRequest): WalletMovement {
    return this.apply(request, LedgerDirection.Debit);
  }

  private apply(
    request: WalletMovementRequest,
    direction: LedgerDirection,
  ): WalletMovement {
    const amount = request.money;
    this.assertCurrency(amount);
    this.assertPositive(amount);
    if (
      direction === LedgerDirection.Debit &&
      this.balanceValue.isLessThan(amount)
    ) {
      throw new InsufficientFundsError("Wallet balance is insufficient");
    }
    this.assertVersionCanIncrement();

    const balanceBefore = this.balanceValue;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(amount)
        : balanceBefore.subtract(amount);
    const entry = WalletLedgerEntry.create({
      id: request.entryId,
      walletId: this.id,
      transactionId: request.transactionId,
      direction,
      money: amount,
      balanceBefore,
      balanceAfter,
      ...(request.occurredAt === undefined
        ? {}
        : { createdAt: request.occurredAt }),
    });

    this.balanceValue = balanceAfter;
    this.versionValue += 1;
    return WalletMovement.of({ entry, version: this.versionValue });
  }

  snapshot(): WalletSnapshot {
    return {
      id: this.id,
      providerId: this.providerId,
      playerId: this.playerId,
      currency: this.currency,
      balance: this.balanceValue.toDecimal(),
      version: this.versionValue,
    };
  }

  private assertCurrency(amount: Money): void {
    if (amount.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet uses ${this.currency}, received ${amount.currency}`,
      );
    }
  }

  private assertPositive(amount: Money): void {
    if (!amount.isPositive()) {
      throw new InvalidWalletError("Wallet movement must be greater than zero");
    }
  }

  private assertVersionCanIncrement(): void {
    if (!Number.isSafeInteger(this.versionValue + 1)) {
      throw new InvalidWalletError(
        "Wallet version exceeds the safe integer range",
      );
    }
  }
}
