import { describe, expect, test } from "bun:test";
import {
  ConflictReason,
  FinancialOperation,
  InboxMessage,
  InvalidPayloadError,
  OutboxMessage,
  OutboxRetryPolicy,
  OutboxStatus,
  PayloadFingerprint,
} from "../src/modules/finance/domain/index.js";

const operationId = "44444444-4444-4444-8444-444444444444";
const otherOperationId = "55555555-5555-4555-8555-555555555555";
const providerId = "11111111-1111-4111-8111-111111111111";

function operation(overrides: {
  readonly id?: string;
  readonly payloadHash?: string;
  readonly status?: string;
  readonly completedAt?: Date | null;
}): FinancialOperation {
  return FinancialOperation.rehydrate({
    id: overrides.id ?? operationId,
    providerId,
    idempotencyKey: "key-1",
    externalTransactionId: "ext-1",
    payloadHash: overrides.payloadHash ?? "a".repeat(64),
    responseSnapshot: {
      externalTransactionId: "ext-1",
      status: overrides.status ?? "PROCESSED",
      failureCode: null,
    },
    responseHttpStatus: 200,
    completedAt:
      overrides.completedAt === undefined
        ? new Date("2026-11-07T10:00:00.000Z")
        : overrides.completedAt,
  });
}

function identity(digest: string) {
  return {
    idempotencyKey: "key-1",
    externalTransactionId: "ext-1",
    fingerprint: PayloadFingerprint.fromDigest(digest),
  };
}

describe("PayloadFingerprint", () => {
  test("key order does not change the digest", () => {
    const a = PayloadFingerprint.of({ amount: "10.00", currency: "BRL" });
    const b = PayloadFingerprint.of({ currency: "BRL", amount: "10.00" });

    expect(a.toString()).toBe(b.toString());
    expect(a.equals(b)).toBe(true);
  });

  test("nested key order does not change the digest either", () => {
    const a = PayloadFingerprint.of({ outer: { x: 1, y: [{ p: 1, q: 2 }] } });
    const b = PayloadFingerprint.of({ outer: { y: [{ q: 2, p: 1 }], x: 1 } });

    expect(a.toString()).toBe(b.toString());
  });

  test("a different value changes the digest", () => {
    expect(
      PayloadFingerprint.of({ amount: "10.00" }).equals(
        PayloadFingerprint.of({ amount: "10.01" }),
      ),
    ).toBe(false);
  });

  test("an absent field and an explicit undefined hash alike", () => {
    expect(
      PayloadFingerprint.of({ a: 1 }).equals(
        PayloadFingerprint.of({ a: 1, b: undefined }),
      ),
    ).toBe(true);
  });

  test("an explicit null is a distinct value, not an absent field", () => {
    expect(
      PayloadFingerprint.of({ a: 1 }).equals(
        PayloadFingerprint.of({ a: 1, b: null }),
      ),
    ).toBe(false);
  });

  test("array order is significant", () => {
    expect(
      PayloadFingerprint.of({ xs: [1, 2] }).equals(
        PayloadFingerprint.of({ xs: [2, 1] }),
      ),
    ).toBe(false);
  });

  test("comparison against a stored digest ignores case", () => {
    const digest = PayloadFingerprint.of({ a: 1 }).toString();

    expect(
      PayloadFingerprint.fromDigest(digest.toUpperCase()).matchesDigest(digest),
    ).toBe(true);
  });

  test("an unreadable stored digest never matches", () => {
    const fingerprint = PayloadFingerprint.of({ a: 1 });

    expect(fingerprint.matchesDigest(null)).toBe(false);
    expect(fingerprint.matchesDigest("not-a-digest")).toBe(false);
  });

  test("a malformed digest is refused at the boundary", () => {
    expect(() => PayloadFingerprint.fromDigest("abc")).toThrow(
      InvalidPayloadError,
    );
  });

  test("a non-finite number is refused rather than hashed as null", () => {
    expect(() => PayloadFingerprint.of({ a: Number.NaN })).toThrow(
      InvalidPayloadError,
    );
  });

  test("a circular payload is refused instead of overflowing the stack", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;

    expect(() => PayloadFingerprint.of(payload)).toThrow(InvalidPayloadError);
  });
});

describe("FinancialOperation replay decision", () => {
  const digest = "a".repeat(64);

  test("a completed operation with the same payload replays", () => {
    const decision = FinancialOperation.resolveReplay(
      identity(digest),
      operation({}),
      operation({}),
    );

    expect(decision?.kind).toBe("replay");
  });

  test("a pending-reference operation resumes instead of replaying", () => {
    const decision = FinancialOperation.resolveReplay(
      identity(digest),
      operation({ status: "PENDING_REFERENCE", completedAt: null }),
      null,
    );

    expect(decision?.kind).toBe("resume");
  });

  test("a pending-reference operation that completed still replays", () => {
    const decision = FinancialOperation.resolveReplay(
      identity(digest),
      operation({ status: "PENDING_REFERENCE" }),
      null,
    );

    expect(decision?.kind).toBe("replay");
  });

  test("the same key with a different payload conflicts", () => {
    const decision = FinancialOperation.resolveReplay(
      identity("b".repeat(64)),
      operation({}),
      null,
    );

    expect(decision).toEqual({
      kind: "conflict",
      reason: ConflictReason.PayloadChanged,
      storedDigest: digest,
    });
  });

  test("a payload conflict outranks resuming a pending operation", () => {
    const decision = FinancialOperation.resolveReplay(
      identity("b".repeat(64)),
      operation({ status: "PENDING_REFERENCE", completedAt: null }),
      null,
    );

    expect(decision?.kind).toBe("conflict");
  });

  test("the key and the transaction ID pointing at different operations conflicts", () => {
    const decision = FinancialOperation.resolveReplay(
      identity(digest),
      operation({}),
      operation({ id: otherOperationId }),
    );

    expect(decision).toEqual({
      kind: "conflict",
      reason: ConflictReason.IdentitySplit,
      storedDigest: digest,
    });
  });

  test("resolving by the external transaction ID alone works", () => {
    const decision = FinancialOperation.resolveReplay(
      identity(digest),
      null,
      operation({}),
    );

    expect(decision?.kind).toBe("replay");
  });

  test("neither identity present is not a replay", () => {
    expect(
      FinancialOperation.resolveReplay(identity(digest), null, null),
    ).toBeNull();
  });
});

describe("InboxMessage", () => {
  const state = {
    id: operationId,
    consumerName: "wager-command",
    messageId: "sqs-1",
    payloadHash: "a".repeat(64),
  };

  test("a redelivery of the same payload is recognized", () => {
    const message = InboxMessage.rehydrate(state);

    expect(
      message.isRedeliveryOf(PayloadFingerprint.fromDigest("a".repeat(64))),
    ).toBe(true);
  });

  test("the same message ID with a different payload is not a redelivery", () => {
    const message = InboxMessage.rehydrate(state);

    expect(
      message.isRedeliveryOf(PayloadFingerprint.fromDigest("b".repeat(64))),
    ).toBe(false);
  });

  test("an empty consumer name is refused", () => {
    expect(() =>
      InboxMessage.rehydrate({ ...state, consumerName: "  " }),
    ).toThrow(InvalidPayloadError);
  });
});

describe("OutboxRetryPolicy", () => {
  const policy = OutboxRetryPolicy.of(1_000, 60_000);

  test("the first attempt waits exactly the base delay", () => {
    expect(policy.delayAfter(0)).toBe(1_000);
    expect(policy.delayAfter(1)).toBe(1_000);
  });

  test("the delay doubles per attempt", () => {
    expect(policy.delayAfter(2)).toBe(2_000);
    expect(policy.delayAfter(3)).toBe(4_000);
    expect(policy.delayAfter(4)).toBe(8_000);
  });

  test("the delay is capped and never becomes Infinity", () => {
    expect(policy.delayAfter(30)).toBe(60_000);
    expect(policy.delayAfter(5_000)).toBe(60_000);
  });

  test("a max below the base is refused", () => {
    expect(() => OutboxRetryPolicy.of(1_000, 500)).toThrow(InvalidPayloadError);
  });
});

describe("OutboxMessage", () => {
  const state = {
    id: operationId,
    aggregateId: otherOperationId,
    eventType: "wager.processed",
    payload: { wagerTransactionId: "tx-1", walletId: "w-1" },
    status: OutboxStatus.Processing,
    attempts: 3,
    createdAt: "2026-11-07T10:00:00.000Z",
    publishedAt: null,
  };

  test("the next attempt is scheduled from the retry policy", () => {
    const event = OutboxMessage.rehydrate(state);
    const now = new Date("2026-11-07T10:00:00.000Z");

    expect(
      event.nextAttemptAt(OutboxRetryPolicy.of(1_000, 60_000), now).getTime(),
    ).toBe(now.getTime() + 4_000);
  });

  test("the correlation ID falls back through the payload to the event ID", () => {
    expect(OutboxMessage.rehydrate(state).correlationId()).toBe("tx-1");
    expect(
      OutboxMessage.rehydrate({
        ...state,
        payload: { correlationId: "corr-1", wagerTransactionId: "tx-1" },
      }).correlationId(),
    ).toBe("corr-1");
    expect(
      OutboxMessage.rehydrate({ ...state, payload: {} }).correlationId(),
    ).toBe(operationId);
    expect(
      OutboxMessage.rehydrate({ ...state, payload: null }).correlationId(),
    ).toBe(operationId);
  });

  test("an unknown status is refused", () => {
    expect(() =>
      OutboxMessage.rehydrate({ ...state, status: "ARCHIVED" }),
    ).toThrow(InvalidPayloadError);
  });

  test("negative attempts are refused", () => {
    expect(() => OutboxMessage.rehydrate({ ...state, attempts: -1 })).toThrow(
      InvalidPayloadError,
    );
  });

  test("a published event reports itself as published", () => {
    expect(
      OutboxMessage.rehydrate({
        ...state,
        status: OutboxStatus.Published,
        publishedAt: "2026-11-07T10:00:01.000Z",
      }).isPublished(),
    ).toBe(true);
    expect(OutboxMessage.rehydrate(state).isPublished()).toBe(false);
  });
});
