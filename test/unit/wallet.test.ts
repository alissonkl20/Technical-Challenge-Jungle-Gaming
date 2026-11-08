import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidWalletError,
  Money,
  Player,
  PlayerStatus,
  Provider,
  ProviderStatus,
  Wallet,
} from "../../src/modules/finance/domain/index.js";

const providerId = "11111111-1111-4111-8111-111111111111";

const playerId = "22222222-2222-4222-8222-222222222222";

const walletId = "33333333-3333-4333-8333-333333333333";

const transactionId = "44444444-4444-4444-8444-444444444444";

const entryId = "66666666-6666-4666-8666-666666666666";

function movement(money: Money) {
  return { entryId, transactionId, money };
}

describe("Wallet", () => {
  test("opens at zero and changes its version only when the balance changes", () => {
    const wallet = Wallet.open({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
    });

    expect(wallet.balance.toDecimal()).toBe("0.00");
    expect(wallet.version).toBe(1);
    // A zero movement is not a movement: it would produce an unbalanced entry.
    expect(() => wallet.credit(movement(Money.zero("BRL")))).toThrow(
      InvalidWalletError,
    );
    expect(wallet.version).toBe(1);

    const credited = wallet.credit(movement(Money.fromDecimal("10.25", "BRL")));
    expect(wallet.balance.toDecimal()).toBe("10.25");
    expect(wallet.version).toBe(2);
    expect(credited.version).toBe(2);
    expect(credited.entry.isBalanced()).toBe(true);
    expect(credited.entry.snapshot()).toMatchObject({
      direction: "CREDIT",
      amount: "10.25",
      balanceBefore: "0.00",
      balanceAfter: "10.25",
    });

    const debited = wallet.debit(movement(Money.fromDecimal("10.25", "BRL")));
    expect(wallet.balance.toDecimal()).toBe("0.00");
    expect(wallet.version).toBe(3);
    expect(debited.entry.snapshot()).toMatchObject({
      direction: "DEBIT",
      balanceBefore: "10.25",
      balanceAfter: "0.00",
    });
  });

  test("rehydrates persisted state and rejects invalid persisted balances or versions", () => {
    const wallet = Wallet.rehydrate({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
      balance: "4.20",
      version: 7,
    });

    expect(wallet.snapshot()).toEqual({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
      balance: "4.20",
      version: 7,
    });
    expect(() =>
      Wallet.rehydrate({
        id: walletId,
        providerId,
        playerId,
        currency: "BRL",
        balance: "-0.01",
        version: 1,
      }),
    ).toThrow(InvalidWalletError);
    expect(() =>
      Wallet.rehydrate({
        id: walletId,
        providerId,
        playerId,
        currency: "BRL",
        balance: "0.00",
        version: 0,
      }),
    ).toThrow(InvalidWalletError);
  });

  test("prevents negative balances, negative movements, and currency mismatches", () => {
    const wallet = Wallet.open({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
    });

    expect(() =>
      wallet.debit(movement(Money.fromDecimal("0.01", "BRL"))),
    ).toThrow(InsufficientFundsError);
    expect(() =>
      wallet.credit(movement(Money.fromDecimal("-1.00", "BRL"))),
    ).toThrow(InvalidWalletError);
    expect(() =>
      wallet.debit(movement(Money.fromDecimal("1.00", "USD"))),
    ).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("does not mutate balance or version when credit exceeds decimal precision", () => {
    const wallet = Wallet.rehydrate({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
      balance: "999999999999999999.99",
      version: 7,
    });

    expect(() =>
      wallet.credit(movement(Money.fromDecimal("0.01", "BRL"))),
    ).toThrow(InvalidMoneyError);
    expect(wallet.snapshot()).toEqual({
      id: walletId,
      providerId,
      playerId,
      currency: "BRL",
      balance: "999999999999999999.99",
      version: 7,
    });
  });
});

describe("Provider and Player", () => {
  test("registers providers active, changes status, and validates rehydration", () => {
    const provider = Provider.register({
      id: providerId,
      code: " provider-code ",
      name: " Provider Name ",
    });

    expect(provider.snapshot()).toEqual({
      id: providerId,
      code: "provider-code",
      name: "Provider Name",
      status: ProviderStatus.ACTIVE,
    });
    provider.deactivate();
    expect(provider.status).toBe(ProviderStatus.INACTIVE);
    expect(() =>
      Provider.rehydrate({
        ...provider.snapshot(),
        status: "UNKNOWN",
      }),
    ).toThrow();
  });

  test("scopes player identity to provider and supports suspension", () => {
    const player = Player.register({
      id: playerId,
      providerId,
      externalPlayerId: " external-100 ",
    });

    expect(player.snapshot()).toEqual({
      id: playerId,
      providerId,
      externalPlayerId: "external-100",
      status: PlayerStatus.ACTIVE,
    });
    player.suspend();
    expect(player.status).toBe(PlayerStatus.SUSPENDED);
    player.activate();
    expect(player.status).toBe(PlayerStatus.ACTIVE);
    expect(() =>
      Player.register({
        id: playerId,
        providerId,
        externalPlayerId: " ",
      }),
    ).toThrow();
  });
});
