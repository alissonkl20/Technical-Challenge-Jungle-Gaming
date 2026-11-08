import { describe, expect, test } from "bun:test";
import {
  evaluateWagerReference,
  FailureCode,
  InvalidLedgerEntryError,
  InvalidStateTransitionError,
  Money,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  Wallet,
  WalletLedgerEntry,
} from "../../src/modules/finance/domain/index.js";

const providerId = "11111111-1111-4111-8111-111111111111";
const playerId = "22222222-2222-4222-8222-222222222222";
const walletId = "33333333-3333-4333-8333-333333333333";
const otherWalletId = "99999999-9999-4999-8999-999999999999";
const fingerprint = "b".repeat(64);

let sequence = 0;
function uuid(): string {
  sequence += 1;
  return `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`;
}

function brl(amount: string): Money {
  return Money.fromDecimal(amount, "BRL");
}

function wager(
  kind: WagerTransactionKind,
  overrides: {
    readonly amount?: string;
    readonly currency?: string;
    readonly reference?: string;
    readonly roundId?: string;
  } = {},
): WagerTransaction {
  return WagerTransaction.create({
    id: uuid(),
    providerId,
    playerId,
    walletId,
    financialOperationId: uuid(),
    externalTransactionId: `external-${uuid()}`,
    idempotencyKey: `key-${uuid()}`,
    payloadFingerprint: fingerprint,
    kind,
    amount: overrides.amount ?? "10.00",
    currency: overrides.currency ?? "BRL",
    roundId: overrides.roundId ?? "round-1",
    ...(overrides.reference === undefined
      ? {}
      : { externalReferenceTransactionId: overrides.reference }),
  });
}

/** A processed reference, as it comes back from persistence. */
function processedReference(
  kind: WagerTransactionKind,
  overrides: {
    readonly amount?: string;
    readonly currency?: string;
    readonly roundId?: string | null;
    readonly walletId?: string;
    readonly status?: WagerTransactionStatus;
  } = {},
): WagerTransaction {
  const status = overrides.status ?? WagerTransactionStatus.PROCESSED;
  const terminal =
    status === WagerTransactionStatus.PROCESSED ||
    status === WagerTransactionStatus.REJECTED ||
    status === WagerTransactionStatus.FAILED;
  const at = "2026-01-01T00:00:00.000Z";
  return WagerTransaction.rehydrate({
    id: uuid(),
    providerId,
    playerId,
    walletId: overrides.walletId ?? walletId,
    financialOperationId: uuid(),
    externalTransactionId: `reference-${uuid()}`,
    idempotencyKey: `reference-key-${uuid()}`,
    payloadFingerprint: fingerprint,
    externalReferenceTransactionId: null,
    referenceTransactionId: null,
    roundId: overrides.roundId === undefined ? "round-1" : overrides.roundId,
    gameId: null,
    kind,
    status,
    amount: overrides.amount ?? "10.00",
    currency: overrides.currency ?? "BRL",
    failureCode:
      status === WagerTransactionStatus.REJECTED ||
      status === WagerTransactionStatus.FAILED
        ? FailureCode.InsufficientFunds
        : null,
    createdAt: at,
    processedAt: status === WagerTransactionStatus.PROCESSED ? at : null,
    completedAt: terminal ? at : null,
  });
}

function openWallet(balance: string): Wallet {
  return Wallet.rehydrate({
    id: walletId,
    providerId,
    playerId,
    currency: "BRL",
    balance,
    version: 1,
  });
}

const context = { playerId, walletId, currency: "BRL", roundId: "round-1" };

describe("operation rules", () => {
  test("BET debits the wallet and writes one DEBIT entry", () => {
    const bet = wager(WagerTransactionKind.BET, { amount: "25.00" });
    const wallet = openWallet("100.00");

    expect(bet.affectsBalance()).toBe(true);
    expect(bet.requiresReference()).toBe(false);
    expect(bet.ledgerDirectionFor()).toBe("DEBIT");

    const applied = wallet.debit({
      entryId: uuid(),
      transactionId: bet.id,
      money: bet.amount,
    });

    expect(wallet.balance.toDecimal()).toBe("75.00");
    expect(applied.entry.snapshot()).toMatchObject({
      direction: "DEBIT",
      amount: "25.00",
      balanceBefore: "100.00",
      balanceAfter: "75.00",
    });
  });

  test("BET is refused when the balance cannot cover it", () => {
    const bet = wager(WagerTransactionKind.BET, { amount: "100.01" });
    const wallet = openWallet("100.00");

    expect(() =>
      wallet.debit({
        entryId: uuid(),
        transactionId: bet.id,
        money: bet.amount,
      }),
    ).toThrow(/insufficient/i);
    expect(wallet.balance.toDecimal()).toBe("100.00");
    expect(wallet.version).toBe(1);
  });

  test("WIN credits the wallet and may name the BET it settles", () => {
    const win = wager(WagerTransactionKind.WIN, {
      amount: "40.00",
      reference: "bet-1",
    });
    const wallet = openWallet("75.00");

    expect(win.ledgerDirectionFor()).toBe("CREDIT");
    expect(win.requiresReference()).toBe(false);
    expect(win.isBetResult()).toBe(true);
    expect(win.isReversal()).toBe(false);
    // Without a reference the WIN is an uncorrelated credit (contract: "pode
    // referenciar a BET").
    expect(wager(WagerTransactionKind.WIN).ledgerDirectionFor()).toBe("CREDIT");

    const applied = wallet.credit({
      entryId: uuid(),
      transactionId: win.id,
      money: win.amount,
    });

    expect(wallet.balance.toDecimal()).toBe("115.00");
    expect(applied.direction).toBe("CREDIT");
    expect(
      evaluateWagerReference(
        wager(WagerTransactionKind.WIN, { reference: "bet-1" }),
        processedReference(WagerTransactionKind.BET),
        context,
      ),
    ).toEqual({ kind: "eligible" });
  });

  test("LOSS records the result without moving the balance or the ledger", () => {
    const loss = wager(WagerTransactionKind.LOSS, { reference: "bet-1" });

    expect(loss.affectsBalance()).toBe(false);
    expect(loss.ledgerDirectionFor()).toBeNull();
    expect(loss.requiresReference()).toBe(false);
    expect(loss.isBetResult()).toBe(true);
    expect(wager(WagerTransactionKind.LOSS).affectsBalance()).toBe(false);
    // REFUND and ROLLBACK keep requiring a reference; BET accepts none.
    expect(() => wager(WagerTransactionKind.REFUND)).toThrow(
      /requires a transaction reference/,
    );
    expect(() =>
      wager(WagerTransactionKind.BET, { reference: "bet-0" }),
    ).toThrow(/cannot reference another transaction/);
    // A WIN's amount is the prize, unrelated to the stake; only reversals must
    // match the referenced amount.
    expect(
      evaluateWagerReference(
        wager(WagerTransactionKind.LOSS, {
          amount: "1.00",
          reference: "bet-1",
        }),
        processedReference(WagerTransactionKind.BET, { amount: "25.00" }),
        context,
      ),
    ).toEqual({ kind: "eligible" });
  });

  test("REFUND credits back a processed BET of equal value, only once", () => {
    const refund = wager(WagerTransactionKind.REFUND, {
      amount: "25.00",
      reference: "bet-1",
    });

    expect(refund.requiresReference()).toBe(true);
    expect(refund.ledgerDirectionFor()).toBe("CREDIT");
    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.BET, { amount: "25.00" }),
        context,
      ),
    ).toEqual({ kind: "eligible" });

    // Partial reversal is out of scope.
    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.BET, { amount: "20.00" }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceAmountMismatch,
    });

    // A REFUND only reverses a BET.
    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.WIN, { amount: "25.00" }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceKindNotEligible,
    });
  });

  test("ROLLBACK inverts the direction of its reference", () => {
    const rollback = wager(WagerTransactionKind.ROLLBACK, {
      amount: "25.00",
      reference: "target-1",
    });

    expect(rollback.ledgerDirectionFor(WagerTransactionKind.BET)).toBe(
      "CREDIT",
    );
    expect(rollback.ledgerDirectionFor(WagerTransactionKind.WIN)).toBe("DEBIT");
    expect(rollback.ledgerDirectionFor(WagerTransactionKind.REFUND)).toBe(
      "DEBIT",
    );
    expect(() => rollback.ledgerDirectionFor()).toThrow(
      InvalidStateTransitionError,
    );

    for (const kind of [
      WagerTransactionKind.BET,
      WagerTransactionKind.WIN,
      WagerTransactionKind.REFUND,
    ]) {
      expect(
        evaluateWagerReference(
          rollback,
          processedReference(kind, { amount: "25.00" }),
          context,
        ),
      ).toEqual({ kind: "eligible" });
    }
    expect(
      evaluateWagerReference(
        rollback,
        processedReference(WagerTransactionKind.ROLLBACK, { amount: "25.00" }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceKindNotEligible,
    });
  });

  test("a reversal that would overdraw the wallet is distinct from a bet without funds", () => {
    const rollback = wager(WagerTransactionKind.ROLLBACK, {
      amount: "10.00",
      reference: "win-1",
    });
    const wallet = openWallet("0.00");

    // The direction inverts a WIN, so the wallet is debited and has no funds.
    expect(rollback.ledgerDirectionFor(WagerTransactionKind.WIN)).toBe("DEBIT");
    expect(() =>
      wallet.debit({
        entryId: uuid(),
        transactionId: rollback.id,
        money: rollback.amount,
      }),
    ).toThrow(/insufficient/i);

    rollback.reject(FailureCode.ReversalInsufficientFunds);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(rollback.isTerminal()).toBe(true);
  });

  test("OPENING is internal and credits the wallet", () => {
    const opening = WagerTransaction.createOpening({
      id: uuid(),
      providerId,
      playerId,
      walletId,
      amount: "1000.00",
      currency: "BRL",
    });

    expect(opening.kind).toBe(WagerTransactionKind.OPENING);
    expect(opening.ledgerDirectionFor()).toBe("CREDIT");
    expect(() =>
      WagerTransaction.create({
        id: uuid(),
        providerId,
        playerId,
        walletId,
        financialOperationId: uuid(),
        externalTransactionId: "external-opening",
        idempotencyKey: "key-opening",
        payloadFingerprint: fingerprint,
        kind: WagerTransactionKind.OPENING,
        amount: "1.00",
        currency: "BRL",
      }),
    ).toThrow(/internal only/i);
  });
});

describe("reference policy", () => {
  test("an operation without a reference does not require one", () => {
    expect(
      evaluateWagerReference(wager(WagerTransactionKind.BET), null, context),
    ).toEqual({ kind: "not-required" });
  });

  test("a missing reference is pending, not a rejection", () => {
    expect(
      evaluateWagerReference(
        wager(WagerTransactionKind.REFUND, { reference: "absent" }),
        null,
        context,
      ),
    ).toEqual({ kind: "pending" });
  });

  test("a reference still being decided is pending", () => {
    for (const status of [
      WagerTransactionStatus.PENDING,
      WagerTransactionStatus.PENDING_REFERENCE,
    ]) {
      expect(
        evaluateWagerReference(
          wager(WagerTransactionKind.REFUND, { reference: "bet-1" }),
          processedReference(WagerTransactionKind.BET, { status }),
          context,
        ),
      ).toEqual({ kind: "pending" });
    }
  });

  test("a terminal non-processed reference is rejected", () => {
    expect(
      evaluateWagerReference(
        wager(WagerTransactionKind.REFUND, { reference: "bet-1" }),
        processedReference(WagerTransactionKind.BET, {
          status: WagerTransactionStatus.REJECTED,
        }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceNotProcessed,
    });
  });

  test("a reference from another wallet, currency or round is rejected", () => {
    const refund = wager(WagerTransactionKind.REFUND, { reference: "bet-1" });

    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.BET, {
          walletId: otherWalletId,
        }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceContextMismatch,
    });
    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.BET, { currency: "USD" }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceContextMismatch,
    });
    expect(
      evaluateWagerReference(
        refund,
        processedReference(WagerTransactionKind.BET, { roundId: "round-2" }),
        context,
      ),
    ).toEqual({
      kind: "rejected",
      failureCode: FailureCode.ReferenceRoundMismatch,
    });
  });
});

describe("ledger entry", () => {
  test("rejects an entry whose arithmetic does not close", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: uuid(),
        walletId,
        transactionId: uuid(),
        direction: "DEBIT",
        money: brl("10.00"),
        balanceBefore: brl("100.00"),
        balanceAfter: brl("95.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejects a zero amount, a negative balance and mixed currencies", () => {
    const base = {
      id: uuid(),
      walletId,
      transactionId: uuid(),
      direction: "CREDIT" as const,
    };

    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl("0.00"),
        balanceBefore: brl("10.00"),
        balanceAfter: brl("10.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: brl("10.00"),
        balanceBefore: Money.fromDecimal("-10.00", "BRL"),
        balanceAfter: brl("0.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: Money.fromDecimal("10.00", "USD"),
        balanceBefore: brl("0.00"),
        balanceAfter: brl("10.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("is structurally immutable once created", () => {
    const entry = WalletLedgerEntry.create({
      id: uuid(),
      walletId,
      transactionId: uuid(),
      direction: "CREDIT",
      money: brl("10.00"),
      balanceBefore: brl("0.00"),
      balanceAfter: brl("10.00"),
    });

    expect(entry.isBalanced()).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});

describe("post-commit compensation switch", () => {
  test("is off unless explicitly enabled", async () => {
    const { isCompensationEnabled } = await import(
      "../../src/config/settings.js"
    );
    expect(isCompensationEnabled(undefined)).toBe(false);
    expect(isCompensationEnabled("false")).toBe(false);
    expect(isCompensationEnabled("1")).toBe(false);
    expect(isCompensationEnabled("true")).toBe(true);
    expect(isCompensationEnabled(true)).toBe(true);
  });
});
