import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  INSTANCES,
  type InstanceRequest as Request,
  runAcrossInstances as runInstances,
} from "./support/multi-instance.js";

/**
 * The mandatory concurrency scenarios, each run by three independent OS
 * processes (separate ORM, pool and service instance) against one real
 * PostgreSQL schema. No in-process coordination exists between them: only the
 * database can keep the invariants.
 */
registerPostgresIntegrationSuite(
  "mandatory concurrency scenarios across three application instances",
  (ctx) => {
    const runAcrossInstances = (
      providerId: string,
      requests: readonly Request[],
    ) => runInstances(ctx.schema, providerId, requests);

    async function walletBalance(walletId: string): Promise<string> {
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(walletId),
      );
      if (wallet === null) throw new Error("wallet disappeared");
      return wallet.balance;
    }

    /** Ledger entries other than the OPENING credit, by direction. */
    async function movementEntries(
      walletId: string,
    ): Promise<{ entry_type: string; amount: string }[]> {
      return ctx.orm.em.execute(
        `SELECT entry.entry_type, entry.amount::text AS amount
           FROM "${ctx.schema}".wallet_ledger_entries entry
           JOIN "${ctx.schema}".wager_transactions wager
             ON wager.id = entry.wager_transaction_id
          WHERE entry.wallet_id = ? AND wager.kind <> 'OPENING'`,
        [walletId],
      );
    }

    test("A: balance 10.00, 20 distinct 1.00 BETs -> 10 processed, 10 rejected, balance 0.00", async () => {
      const c = await ctx.seedWagerContext("10.00");
      const requests = Array.from({ length: 20 }, (_, index) => ({
        idempotencyKey: `a-key-${index}-${randomUUID()}`,
        wager: ctx.wagerInput(c.externalPlayerId, `a-bet-${index}`, {
          amount: "1.00",
        }),
      }));

      const results = await runAcrossInstances(c.providerId, requests);

      expect(results.filter((r) => r.error !== null)).toEqual([]);
      expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(10);
      const rejected = results.filter((r) => r.status === "REJECTED");
      expect(rejected).toHaveLength(10);
      expect(new Set(rejected.map((r) => r.failureCode))).toEqual(
        new Set(["INSUFFICIENT_FUNDS"]),
      );
      expect(await walletBalance(c.walletId)).toBe("0.00");
      const entries = await movementEntries(c.walletId);
      expect(entries).toHaveLength(10);
      expect(entries.every((e) => e.entry_type === "DEBIT")).toBe(true);
      expect(entries.every((e) => e.amount === "1.00")).toBe(true);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 60_000);

    test("B: balance 100.00, two distinct 80.00 BETs (each redelivered by every instance) -> one debit, balance 20.00", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const bets = ["b-bet-1", "b-bet-2"].map((externalId) => ({
        idempotencyKey: `${externalId}-${randomUUID()}`,
        wager: ctx.wagerInput(c.externalPlayerId, externalId, {
          amount: "80.00",
        }),
      }));
      // Every instance receives both bets: contention and redelivery at once.
      const requests = Array.from({ length: INSTANCES }, () => bets).flat();

      const results = await runAcrossInstances(c.providerId, requests);

      expect(results.filter((r) => r.error !== null)).toEqual([]);
      const byExternalId = new Map<string, Set<string>>();
      results.forEach((result) => {
        const externalId = result.request.wager.externalTransactionId;
        if (result.status === null) return;
        const statuses = byExternalId.get(externalId) ?? new Set<string>();
        statuses.add(result.status);
        byExternalId.set(externalId, statuses);
      });
      // Each bet has exactly one outcome, whichever instance answered.
      const outcomes = [...byExternalId.values()].map((statuses) => {
        expect(statuses.size).toBe(1);
        return [...statuses][0];
      });
      expect(outcomes.sort()).toEqual(["PROCESSED", "REJECTED"]);
      expect(await walletBalance(c.walletId)).toBe("20.00");
      const entries = await movementEntries(c.walletId);
      expect(entries).toEqual([{ entry_type: "DEBIT", amount: "80.00" }]);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 60_000);

    test("C: 50 identical requests (same provider, ID and payload) -> one movement, 49 replays", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const idempotencyKey = `c-key-${randomUUID()}`;
      const wager = ctx.wagerInput(c.externalPlayerId, "c-bet", {
        amount: "15.00",
      });
      const requests = Array.from({ length: 50 }, () => ({
        idempotencyKey,
        wager,
      }));

      const results = await runAcrossInstances(c.providerId, requests);

      expect(results.filter((r) => r.error !== null)).toEqual([]);
      expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
      expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(await walletBalance(c.walletId)).toBe("85.00");
      expect(await movementEntries(c.walletId)).toEqual([
        { entry_type: "DEBIT", amount: "15.00" },
      ]);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 60_000);

    test("D: one idempotency key with different payloads -> explicit conflicts, one movement at most", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const idempotencyKey = `d-key-${randomUUID()}`;
      const requests = Array.from({ length: 15 }, (_, index) => ({
        idempotencyKey,
        wager: ctx.wagerInput(c.externalPlayerId, "d-bet", {
          amount: `${index + 1}.00`,
        }),
      }));

      const results = await runAcrossInstances(c.providerId, requests);

      const winners = results.filter((r) => r.status === "PROCESSED");
      expect(winners).toHaveLength(1);
      expect(winners[0]?.idempotentReplay).toBe(false);
      const conflicts = results.filter((r) => r.error !== null);
      expect(conflicts).toHaveLength(14);
      expect(new Set(conflicts.map((r) => r.error))).toEqual(
        new Set(["IdempotencyConflictError"]),
      );
      const winnerAmount = winners[0]?.request.wager.amount;
      const entries = await movementEntries(c.walletId);
      expect(entries).toEqual([
        { entry_type: "DEBIT", amount: winnerAmount ?? "" },
      ]);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 60_000);
  },
);
