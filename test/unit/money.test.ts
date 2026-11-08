import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from "../../src/modules/finance/domain/index.js";

describe("Money", () => {
  test("represents decimal values exactly and always renders two digits", () => {
    const amount = Money.fromDecimal("999999999999999999.99", "BRL");

    expect(amount.toDecimal()).toBe("999999999999999999.99");
    expect(
      Money.fromDecimal("0.1", "BRL")
        .add(Money.fromDecimal("0.2", "BRL"))
        .toDecimal(),
    ).toBe("0.30");
    expect(Money.fromDecimal("5", "BRL").toDecimal()).toBe("5.00");
  });

  test("rejects malformed, scientific, non-finite, over-precision and out-of-range amounts", () => {
    for (const amount of [
      "",
      " 1.00",
      "01.00",
      "1.001",
      "1e3",
      "NaN",
      "Infinity",
    ]) {
      expect(() => Money.fromDecimal(amount, "BRL")).toThrow(InvalidMoneyError);
    }

    expect(() => Money.fromDecimal("1000000000000000000.00", "BRL")).toThrow(
      InvalidMoneyError,
    );
  });

  test("rejects arithmetic between different currencies", () => {
    expect(() =>
      Money.fromDecimal("1.00", "BRL").add(Money.fromDecimal("1.00", "USD")),
    ).toThrow(CurrencyMismatchError);
  });

  test("supports negative values for arithmetic without floating point", () => {
    expect(
      Money.fromDecimal("1.00", "BRL")
        .subtract(Money.fromDecimal("2.50", "BRL"))
        .toDecimal(),
    ).toBe("-1.50");
  });

  test("rejects arithmetic beyond the NUMERIC(20,2) boundaries", () => {
    const maximum = Money.fromDecimal("999999999999999999.99", "BRL");
    const minimum = Money.fromDecimal("-999999999999999999.99", "BRL");
    const cent = Money.fromDecimal("0.01", "BRL");

    expect(() => maximum.add(cent)).toThrow(InvalidMoneyError);
    expect(() => minimum.subtract(cent)).toThrow(InvalidMoneyError);
    expect(maximum.subtract(cent).toDecimal()).toBe("999999999999999999.98");
    expect(minimum.add(cent).toDecimal()).toBe("-999999999999999999.98");
  });
});
