import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  FailureCode,
  IdempotencyConflictError,
  IdempotencyReplayError,
  InsufficientFundsError,
  InvalidMoneyError,
  InvalidPayloadError,
  InvalidStateTransitionError,
  InvalidWalletError,
  Money,
  Player,
  PlayerStatus,
  Provider,
  ProviderStatus,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
} from "../src/modules/finance/domain/index.js";

const providerId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const transactionId = "44444444-4444-4444-8444-444444444444";
const operationId = "55555555-5555-4555-8555-555555555555";
const fingerprint = "a".repeat(64);

const entryId = "66666666-6666-4666-8666-666666666666";

function movement(money: Money) {
  return { entryId, transactionId, money };
}

function wagerInput(
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): Parameters<typeof WagerTransaction.create>[0] {
  return {
    id: transactionId,
    providerId,
    playerId,
    walletId,
    financialOperationId: operationId,
    externalTransactionId: "external-transaction-1",
    idempotencyKey: "request-1",
    payloadFingerprint: fingerprint,
    kind: WagerTransactionKind.BET,
    amount: "12.34",
    currency: "BRL",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

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

describe("WagerTransaction", () => {
  test("creates external transactions pending with positive amounts", () => {
    const transaction = WagerTransaction.create(wagerInput());

    expect(transaction.kind).toBe(WagerTransactionKind.BET);
    expect(transaction.status).toBe(WagerTransactionStatus.PENDING);
    expect(transaction.amount.toDecimal()).toBe("12.34");
  });

  test("rejects external OPENING and invalid external payloads", () => {
    expect(() =>
      WagerTransaction.create(
        wagerInput({ kind: WagerTransactionKind.OPENING }),
      ),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      WagerTransaction.create(wagerInput({ amount: "0.00" })),
    ).toThrow(InvalidPayloadError);
    expect(() =>
      WagerTransaction.create(wagerInput({ amount: "1e2" })),
    ).toThrow(InvalidMoneyError);
  });

  test("creates internal OPENING transactions without external idempotency data", () => {
    const transaction = WagerTransaction.createOpening({
      id: transactionId,
      providerId,
      playerId,
      walletId,
      amount: "25.00",
      currency: "BRL",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(transaction.kind).toBe(WagerTransactionKind.OPENING);
    expect(transaction.snapshot().financialOperationId).toBeNull();
    expect(transaction.snapshot().idempotencyKey).toBeNull();
    expect(() =>
      WagerTransaction.rehydrate({
        ...transaction.snapshot(),
        status: WagerTransactionStatus.PENDING_REFERENCE,
      }),
    ).toThrow();
  });

  test("reports an idempotency conflict when the same key has a different payload", () => {
    expect(() =>
      WagerTransaction.create(wagerInput(), {
        key: "request-1",
        payloadFingerprint: "b".repeat(64),
      }),
    ).toThrow(IdempotencyConflictError);
  });

  test("does not create a duplicate for an identical idempotent request", () => {
    expect(() =>
      WagerTransaction.create(wagerInput(), {
        key: "request-1",
        payloadFingerprint: fingerprint.toUpperCase(),
      }),
    ).toThrow(IdempotencyReplayError);
  });

  test("transitions through pending reference and terminal outcomes", () => {
    const processed = WagerTransaction.create(wagerInput());
    processed.markPendingReference();
    expect(processed.status).toBe(WagerTransactionStatus.PENDING_REFERENCE);
    processed.markProcessed("2026-01-01T00:01:00.000Z");
    expect(processed.snapshot().completedAt).toBe("2026-01-01T00:01:00.000Z");
    expect(() => processed.fail(FailureCode.InsufficientFunds)).toThrow(
      InvalidStateTransitionError,
    );

    const rejected = WagerTransaction.create(wagerInput());
    rejected.reject("INSUFFICIENT_FUNDS", "2026-01-01T00:01:00.000Z");
    expect(rejected.status).toBe(WagerTransactionStatus.REJECTED);
    expect(rejected.snapshot().failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  test("rehydrates valid snapshots and rejects inconsistent persisted state", () => {
    const transaction = WagerTransaction.create(wagerInput());
    const persisted = {
      ...transaction.snapshot(),
      status: WagerTransactionStatus.PROCESSED,
      processedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
    };

    expect(WagerTransaction.rehydrate(persisted).status).toBe(
      WagerTransactionStatus.PROCESSED,
    );
    expect(() =>
      WagerTransaction.rehydrate({
        ...persisted,
        completedAt: null,
      }),
    ).toThrow();
    expect(() =>
      WagerTransaction.rehydrate({
        ...transaction.snapshot(),
        financialOperationId: null,
      }),
    ).toThrow();
  });
});
