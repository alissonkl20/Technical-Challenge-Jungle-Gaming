import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

// NUMERIC(20,2) holds at most 18 integer digits and 2 decimals. The largest
// balance is 999999999999999999.99. Values at that edge must be exact, and a
// movement beyond it must be rejected explicitly, never truncated or rounded.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const moneyTests = enabled ? describe : describe.skip;
const MAX = "999999999999999999.99";

moneyTests("money precision at the NUMERIC(20,2) boundary", () => {
  registerPostgresIntegrationSuite("money precision", (ctx) => {
    test("a credit that lands exactly on the maximum balance is exact and reconciles", async () => {
      const c = await ctx.seedWagerContext("1.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "max-bet-key",
        ctx.wagerInput(c.externalPlayerId, "max-bet", {
          kind: WagerTransactionKind.BET,
          amount: "0.01",
        }),
      );
      // Balance is now 0.99; a WIN of 999999999999999999.00 lands on MAX.
      const win = await wagers.process(
        c.providerId,
        "max-win-key",
        ctx.wagerInput(c.externalPlayerId, "max-win", {
          kind: WagerTransactionKind.WIN,
          amount: "999999999999999999.00",
          externalReferenceTransactionId: "max-bet",
        }),
      );
      expect(win.response.status).toBe("PROCESSED");
      expect(win.response.wallet?.balance).toBe(MAX);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("a credit beyond the maximum is rejected explicitly, with no partial effect", async () => {
      const c = await ctx.seedWagerContext("1.01");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        "over-bet-key",
        ctx.wagerInput(c.externalPlayerId, "over-bet", { amount: "0.01" }),
      );
      const over = await wagers.process(
        c.providerId,
        "over-win-key",
        ctx.wagerInput(c.externalPlayerId, "over-win", {
          kind: WagerTransactionKind.WIN,
          amount: "999999999999999999.99",
          externalReferenceTransactionId: "over-bet",
        }),
      );
      expect(over.response.status).toBe("REJECTED");
      expect(over.response.failureCode).toBe("BALANCE_LIMIT_EXCEEDED");
      expect(over.response.wallet?.balance).toBe("1.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("an amount with more than two decimals or 19 integer digits is rejected at the contract", async () => {
      const c = await ctx.seedWagerContext("1.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      for (const amount of ["1.001", "1000000000000000000.00"]) {
        let message = "";
        try {
          await wagers.process(
            c.providerId,
            `bad-${amount}`,
            ctx.wagerInput(c.externalPlayerId, `bad-${amount}`, {
              kind: WagerTransactionKind.BET,
              amount,
            }),
          );
        } catch (error) {
          message = String(error);
        }
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });
});
