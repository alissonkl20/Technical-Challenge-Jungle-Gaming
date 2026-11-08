import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";
import { type CurrencyCode, currencyCode } from "./types.js";

/** Transport representation of money: an exact decimal string plus ISO-4217. */
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const MAX_MINOR_UNITS = 99_999_999_999_999_999_999n;
const DECIMAL_PATTERN = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {
    Object.freeze(this);
  }

  static fromDecimal(amount: string, currency: string): Money {
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("Money amount must be a decimal string");
    }

    const match = DECIMAL_PATTERN.exec(amount);
    if (match === null) {
      throw new InvalidMoneyError(
        "Money amount must be a plain decimal with at most two fractional digits",
      );
    }

    const [, sign, whole, fraction = ""] = match;
    if (whole.length > 18) {
      throw new InvalidMoneyError(
        "Money amount exceeds NUMERIC(20,2) precision",
      );
    }

    const minorUnits = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    const signedMinorUnits = sign === "-" ? -minorUnits : minorUnits;

    if (minorUnits > MAX_MINOR_UNITS) {
      throw new InvalidMoneyError(
        "Money amount exceeds NUMERIC(20,2) precision",
      );
    }

    return new Money(signedMinorUnits, currencyCode(currency));
  }

  static from(props: MoneyProps): Money {
    return Money.fromDecimal(props.amount, props.currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, currencyCode(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(
      this.minorUnits + other.minorUnits,
      this.currency,
    );
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(
      this.minorUnits - other.minorUnits,
      this.currency,
    );
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.minorUnits < other.minorUnits) return -1;
    if (this.minorUnits > other.minorUnits) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  toJSON(): MoneyProps {
    return { amount: this.toDecimal(), currency: this.currency };
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  toDecimal(): string {
    const absolute = this.minorUnits < 0n ? -this.minorUnits : this.minorUnits;
    const whole = (absolute / 100n).toString();
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${this.minorUnits < 0n ? "-" : ""}${whole}.${fraction}`;
  }

  private static fromMinorUnits(amount: bigint, currency: CurrencyCode): Money {
    if (amount > MAX_MINOR_UNITS || amount < -MAX_MINOR_UNITS) {
      throw new InvalidMoneyError(
        "Money amount exceeds NUMERIC(20,2) precision",
      );
    }

    return new Money(amount, currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Cannot operate on ${this.currency} and ${other.currency}`,
      );
    }
  }
}
