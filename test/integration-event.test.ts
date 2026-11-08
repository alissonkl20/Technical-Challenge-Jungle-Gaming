import { describe, expect, test } from "bun:test";
import {
  eventContext,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../src/modules/events/integration-event.js";
import { LedgerDirection } from "../src/modules/finance/domain/index.js";

const context = {
  correlationId: "request-1",
  causationId: "command-1",
  occurredAt: new Date("2026-07-29T15:00:00.000Z"),
};

describe("versioned integration events", () => {
  test("serializes the stable envelope", () => {
    const event = WagerTransactionProcessed.from(
      {
        wagerTransactionId: "aggregate-1",
        providerId: "provider-a",
        kind: "BET",
        money: { amount: "12.00", currency: "BRL" },
      },
      context,
    );

    expect(event.toJSON()).toEqual({
      eventId: event.eventId,
      eventType: "WagerTransactionProcessed",
      aggregateId: "aggregate-1",
      correlationId: "request-1",
      causationId: "command-1",
      occurredAt: "2026-07-29T15:00:00.000Z",
      version: 1,
      data: {
        wagerTransactionId: "aggregate-1",
        providerId: "provider-a",
        kind: "BET",
        money: { amount: "12.00", currency: "BRL" },
      },
    });
  });

  test("event data is immutable after construction", () => {
    const money = { amount: "12.00", currency: "BRL" };
    const event = WagerTransactionProcessed.from(
      {
        wagerTransactionId: "aggregate-1",
        providerId: "provider-a",
        kind: "BET",
        money,
      },
      context,
    );

    // Mutating the caller's object must not reach the event, and reading the
    // envelope twice must not expose the first reader's copy for edit.
    money.amount = "99.00";
    const first = event.toJSON();
    (first.data.money as { amount: string }).amount = "77.00";

    expect(event.toJSON().data.money).toEqual({
      amount: "12.00",
      currency: "BRL",
    });
  });

  test("the causation ID is omitted rather than serialized as undefined", () => {
    const envelope = WagerTransactionPendingReference.from(
      {
        wagerTransactionId: "aggregate-1",
        providerId: "provider-a",
        externalReferenceTransactionId: "reference-1",
      },
      {
        correlationId: "request-1",
        occurredAt: new Date("2026-07-29T15:00:00.000Z"),
      },
    ).toJSON();

    expect("causationId" in envelope).toBe(false);
  });

  test("the outbox row and its envelope cannot disagree on the type", () => {
    const event = WalletBalanceChanged.from(
      {
        walletId: "wallet-2",
        transactionId: "transaction-2",
        direction: LedgerDirection.Credit,
        money: { amount: "12.00", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "12.00", currency: "BRL" },
        walletVersion: 1,
      },
      context,
    );

    expect(event.toOutboxRow()).toEqual({
      id: event.eventId,
      aggregate_id: "wallet-2",
      event_type: "WalletBalanceChanged",
      payload: {
        eventId: event.eventId,
        eventType: "WalletBalanceChanged",
        aggregateId: "wallet-2",
        correlationId: "request-1",
        causationId: "command-1",
        occurredAt: "2026-07-29T15:00:00.000Z",
        version: 1,
        data: {
          walletId: "wallet-2",
          transactionId: "transaction-2",
          direction: "CREDIT",
          money: { amount: "12.00", currency: "BRL" },
          balanceBefore: { amount: "0.00", currency: "BRL" },
          balanceAfter: { amount: "12.00", currency: "BRL" },
          walletVersion: 1,
        },
      },
    });
  });

  test("the balance event carries exactly the declared fields", () => {
    const data = WalletBalanceChanged.from(
      {
        walletId: "wallet-2",
        transactionId: "transaction-2",
        direction: LedgerDirection.Debit,
        money: { amount: "12.00", currency: "BRL" },
        balanceBefore: { amount: "20.00", currency: "BRL" },
        balanceAfter: { amount: "8.00", currency: "BRL" },
        walletVersion: 3,
      },
      context,
    ).toJSON().data;

    // No aliases and no duplicated currency: the payload is versioned, so
    // every extra field is a field consumers may start depending on.
    expect(Object.keys(data).sort()).toEqual([
      "balanceAfter",
      "balanceBefore",
      "direction",
      "money",
      "transactionId",
      "walletId",
      "walletVersion",
    ]);
  });

  test("a rejection without a transaction is attributed to the operation", () => {
    const event = WagerTransactionRejected.from(
      "operation-9",
      {
        financialOperationId: "operation-9",
        providerId: "provider-a",
        externalTransactionId: "transaction-123",
        failureCode: "PLAYER_NOT_FOUND",
      },
      context,
    );

    expect(event.aggregateId).toBe("operation-9");
    expect(event.eventType).toBe("WagerTransactionRejected");
    expect(event.version).toBe(1);
  });

  test("every event declares a type and a version", () => {
    const events = [
      WagerTransactionProcessed.from(
        {
          wagerTransactionId: "a",
          providerId: "p",
          kind: "BET",
          money: { amount: "1.00", currency: "BRL" },
        },
        context,
      ),
      WagerTransactionRejected.from(
        "a",
        {
          providerId: "p",
          externalTransactionId: "t",
          failureCode: "INSUFFICIENT_FUNDS",
        },
        context,
      ),
      WagerTransactionPendingReference.from(
        {
          wagerTransactionId: "a",
          providerId: "p",
          externalReferenceTransactionId: null,
        },
        context,
      ),
      WalletBalanceChanged.from(
        {
          walletId: "w",
          transactionId: "t",
          direction: LedgerDirection.Credit,
          money: { amount: "1.00", currency: "BRL" },
          balanceBefore: { amount: "0.00", currency: "BRL" },
          balanceAfter: { amount: "1.00", currency: "BRL" },
          walletVersion: 1,
        },
        context,
      ),
    ];

    expect(events.map((event) => event.eventType)).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionRejected",
      "WagerTransactionPendingReference",
      "WalletBalanceChanged",
    ]);
    expect(events.every((event) => event.version === 1)).toBe(true);
  });
});

describe("event context", () => {
  test("it generates a correlation ID when none is active", () => {
    expect(eventContext().correlationId).not.toBe(eventContext().correlationId);
  });

  test("two events built from one shared context get distinct event IDs", () => {
    // One committed fact publishes several events. Sharing an ID between them
    // collides on the outbox primary key, which is why the context has none.
    const shared = eventContext({ correlationId: "request-1" });
    const processed = WagerTransactionProcessed.from(
      {
        wagerTransactionId: "a",
        providerId: "p",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      },
      shared,
    );
    const balance = WalletBalanceChanged.from(
      {
        walletId: "w",
        transactionId: "a",
        direction: LedgerDirection.Debit,
        money: { amount: "1.00", currency: "BRL" },
        balanceBefore: { amount: "1.00", currency: "BRL" },
        balanceAfter: { amount: "0.00", currency: "BRL" },
        walletVersion: 2,
      },
      shared,
    );

    expect(processed.eventId).not.toBe(balance.eventId);
    expect(processed.correlationId).toBe(balance.correlationId);
    expect(processed.occurredAt).toEqual(balance.occurredAt);
  });

  test("an explicit correlation ID wins", () => {
    expect(eventContext({ correlationId: "request-7" }).correlationId).toBe(
      "request-7",
    );
  });
});
