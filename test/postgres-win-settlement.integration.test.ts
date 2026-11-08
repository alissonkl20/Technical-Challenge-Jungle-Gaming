import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite("PostgreSQL WIN settlement rules", (ctx) => {
  describe("WIN settlement against BET state", () => {
    async function walletBalance(
      walletId: string,
    ): Promise<string | undefined> {
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(walletId),
      );
      return wallet?.balance;
    }

    function win(
      player: string,
      externalId: string,
      reference: string,
      amount: string,
    ) {
      return ctx.wagerInput(player, externalId, {
        kind: WagerTransactionKind.WIN,
        externalReferenceTransactionId: reference,
        amount,
      });
    }

    test("BET then WIN settles once and keeps balance equal to the ledger", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-a", { amount: "25.00" }),
      );
      const result = await wagers.process(
        c.providerId,
        "k-win",
        win(c.externalPlayerId, "win-a", "bet-a", "50.00"),
      );
      expect(result.response.status).toBe("PROCESSED");
      expect(await walletBalance(c.walletId)).toBe("125.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("BET -> REFUND -> WIN: the REFUND won, the WIN is rejected and moves no money", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-r", { amount: "25.00" }),
      );
      await wagers.process(
        c.providerId,
        "k-ref",
        ctx.wagerInput(c.externalPlayerId, "refund-r", {
          kind: WagerTransactionKind.REFUND,
          externalReferenceTransactionId: "bet-r",
          amount: "25.00",
        }),
      );
      const result = await wagers.process(
        c.providerId,
        "k-win",
        win(c.externalPlayerId, "win-r", "bet-r", "200.00"),
      );
      expect(result.response.status).toBe("REJECTED");
      // The REFUND was the BET's first valid result: the WIN conflicts.
      expect(result.response.failureCode).toBe("REFERENCE_ALREADY_SETTLED");
      expect(await walletBalance(c.walletId)).toBe("100.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("BET -> ROLLBACK -> WIN is rejected and moves no money", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-b", { amount: "80.00" }),
      );
      await wagers.process(
        c.providerId,
        "k-rb",
        ctx.wagerInput(c.externalPlayerId, "rb-b", {
          kind: WagerTransactionKind.ROLLBACK,
          externalReferenceTransactionId: "bet-b",
          amount: "80.00",
        }),
      );
      const result = await wagers.process(
        c.providerId,
        "k-win",
        win(c.externalPlayerId, "win-b", "bet-b", "300.00"),
      );
      expect(result.response.status).toBe("REJECTED");
      expect(result.response.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
      expect(await walletBalance(c.walletId)).toBe("100.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("a second WIN with another idempotency key and external ID is rejected", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-d", { amount: "10.00" }),
      );
      const first = await wagers.process(
        c.providerId,
        "k-w1",
        win(c.externalPlayerId, "win-d1", "bet-d", "50.00"),
      );
      const second = await wagers.process(
        c.providerId,
        "k-w2",
        win(c.externalPlayerId, "win-d2", "bet-d", "50.00"),
      );
      expect(first.response.status).toBe("PROCESSED");
      expect(second.response.status).toBe("REJECTED");
      expect(second.response.failureCode).toBe("REFERENCE_ALREADY_SETTLED");
      expect(await walletBalance(c.walletId)).toBe("140.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("a WIN that was rolled back does not block a corrected WIN", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-e", { amount: "10.00" }),
      );
      await wagers.process(
        c.providerId,
        "k-w1",
        win(c.externalPlayerId, "win-e1", "bet-e", "50.00"),
      );
      await wagers.process(
        c.providerId,
        "k-rbw",
        ctx.wagerInput(c.externalPlayerId, "rb-e1", {
          kind: WagerTransactionKind.ROLLBACK,
          externalReferenceTransactionId: "win-e1",
          amount: "50.00",
        }),
      );
      const corrected = await wagers.process(
        c.providerId,
        "k-w2",
        win(c.externalPlayerId, "win-e2", "bet-e", "70.00"),
      );
      expect(corrected.response.status).toBe("PROCESSED");
      expect(await walletBalance(c.walletId)).toBe("160.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("concurrent WIN x WIN on one BET yields exactly one credit", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-g", { amount: "10.00" }),
      );
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          wagers.process(
            c.providerId,
            `k-cw-${i}`,
            win(c.externalPlayerId, `win-g-${i}`, "bet-g", "50.00"),
          ),
        ),
      );
      const statuses = results.map((r) => r.response.status).sort();
      expect(statuses.filter((s) => s === "PROCESSED")).toHaveLength(1);
      expect(await walletBalance(c.walletId)).toBe("140.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("concurrent WIN x REFUND on one BET: exactly one settlement applies", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-h", { amount: "10.00" }),
      );
      const [w, r] = await Promise.all([
        wagers.process(
          c.providerId,
          "k-cwh",
          win(c.externalPlayerId, "win-h", "bet-h", "50.00"),
        ),
        wagers.process(
          c.providerId,
          "k-cr",
          ctx.wagerInput(c.externalPlayerId, "refund-h", {
            kind: WagerTransactionKind.REFUND,
            externalReferenceTransactionId: "bet-h",
            amount: "10.00",
          }),
        ),
      ]);

      // Both statuses are legal on their own; whichever applied must be
      // reflected in the ledger.
      expect(["PROCESSED", "REJECTED"]).toContain(w.response.status);
      expect(["PROCESSED", "REJECTED"]).toContain(r.response.status);
      // First valid result recorded wins: exactly one of them is applied, the
      // other is refused as a conflicting result, and only its money moves.
      expect([w.response.status, r.response.status].sort()).toEqual([
        "PROCESSED",
        "REJECTED",
      ]);
      const loser = w.response.status === "REJECTED" ? w : r;
      expect(loser.response.failureCode).toBe("REFERENCE_ALREADY_SETTLED");
      const expected = w.response.status === "PROCESSED" ? "140.00" : "100.00";
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(c.walletId),
      );
      expect(wallet?.balance).toBe(expected);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("concurrent WIN x ROLLBACK on one BET keeps one consistent outcome", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-i", { amount: "10.00" }),
      );
      const [w, rb] = await Promise.all([
        wagers.process(
          c.providerId,
          "k-cwi",
          win(c.externalPlayerId, "win-i", "bet-i", "50.00"),
        ),
        wagers.process(
          c.providerId,
          "k-cri",
          ctx.wagerInput(c.externalPlayerId, "rb-i", {
            kind: WagerTransactionKind.ROLLBACK,
            externalReferenceTransactionId: "bet-i",
            amount: "10.00",
          }),
        ),
      ]);
      expect(rb.response.status).toBe("PROCESSED");
      // ROLLBACK of the BET is valid after a WIN, so the WIN may also be
      // processed first. Either order is consistent; the ledger must agree.
      expect(["PROCESSED", "REJECTED"]).toContain(w.response.status);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("direct SQL cannot insert a second active WIN for one BET", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "k-bet",
        ctx.wagerInput(c.externalPlayerId, "bet-s", { amount: "10.00" }),
      );
      await wagers.process(
        c.providerId,
        "k-w",
        win(c.externalPlayerId, "win-s", "bet-s", "50.00"),
      );
      const [bet] = await ctx.orm.em.execute<{ id: string }[]>(
        `SELECT id FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = 'bet-s'`,
      );
      const opId = crypto.randomUUID();
      await ctx.orm.em.execute(
        `INSERT INTO "${ctx.schema}".financial_operations
             (id, provider_id, idempotency_key, external_transaction_id, payload_hash, response_snapshot, response_http_status, completed_at)
           VALUES (?, ?, 'raw-key-s', 'raw-ext-s', repeat('a', 64), '{}'::jsonb, 200, now())`,
        [opId, c.providerId],
      );
      let message = "";
      try {
        await ctx.orm.em.execute(
          `INSERT INTO "${ctx.schema}".wager_transactions
               (id, provider_id, player_id, wallet_id, financial_operation_id, external_transaction_id,
                reference_transaction_id, kind, status, amount, currency, reference_attempts, processed_at, completed_at)
             SELECT gen_random_uuid(), provider_id, player_id, id, ?, 'raw-win-s',
                    ?, 'WIN', 'PROCESSED', 10.00, currency, 0, now(), now()
               FROM "${ctx.schema}".wallets WHERE id = ?`,
          [opId, bet.id, c.walletId],
        );
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("active WIN");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });
  });
});
