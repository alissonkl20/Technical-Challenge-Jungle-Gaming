import { describe, expect, test } from "bun:test";
import {
  FailureCode,
  IdempotencyConflictError,
  IdempotencyReplayError,
  InvalidMoneyError,
  InvalidPayloadError,
  InvalidStateTransitionError,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/modules/finance/domain/index.js";

const providerId = "11111111-1111-4111-8111-111111111111";

const playerId = "22222222-2222-4222-8222-222222222222";

const walletId = "33333333-3333-4333-8333-333333333333";

const transactionId = "44444444-4444-4444-8444-444444444444";

const operationId = "55555555-5555-4555-8555-555555555555";

const fingerprint = "a".repeat(64);

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
