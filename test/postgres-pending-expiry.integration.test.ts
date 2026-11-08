import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL pending reference expiry",
  (ctx) => {
    describe("expiry is decided after the reference is resolved", () => {
      async function expireWager(externalId: string): Promise<void> {
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_transactions
              SET reference_expires_at = now() - interval '1 second'
            WHERE external_transaction_id = ?`,
          [externalId],
        );
      }

      async function balance(walletId: string): Promise<string | undefined> {
        const wallet = await ctx.transactionManager.transaction((session) =>
          session.wallets.findById(walletId),
        );
        return wallet?.balance;
      }

      function win(player: string, externalId: string, reference: string) {
        return ctx.wagerInput(player, externalId, {
          kind: WagerTransactionKind.WIN,
          externalReferenceTransactionId: reference,
          amount: "50.00",
        });
      }

      test("1-2. WIN arriving before its BET stays pending", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const result = await wagers.process(
          c.providerId,
          "k-w",
          win(c.externalPlayerId, "w-1", "b-1"),
        );
        expect(result.response.status).toBe("PENDING_REFERENCE");
        expect(result.httpStatus).toBe(202);
        expect(await balance(c.walletId)).toBe("100.00");
      });

      test("3-4. BET inside the TTL, then the WIN is resumed and processed", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const win1 = win(c.externalPlayerId, "w-3", "b-3");
        await wagers.process(c.providerId, "k-w3", win1);
        await wagers.process(
          c.providerId,
          "k-b3",
          ctx.wagerInput(c.externalPlayerId, "b-3", { amount: "10.00" }),
        );
        const resumed = await wagers.process(c.providerId, "k-w3", win1);
        expect(resumed.response.status).toBe("PROCESSED");
        expect(await balance(c.walletId)).toBe("140.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("5. BET arriving after the TTL is still honored when the WIN is retried", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const win5 = win(c.externalPlayerId, "w-5", "b-5");
        await wagers.process(c.providerId, "k-w5", win5);
        await expireWager("w-5");
        await wagers.process(
          c.providerId,
          "k-b5",
          ctx.wagerInput(c.externalPlayerId, "b-5", { amount: "10.00" }),
        );
        const retried = await wagers.process(c.providerId, "k-w5", win5);
        expect(retried.response.status).toBe("PROCESSED");
        expect(await balance(c.walletId)).toBe("140.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("6. reference still missing after the TTL is rejected with REFERENCE_NOT_FOUND", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const win6 = win(c.externalPlayerId, "w-6", "b-6");
        await wagers.process(c.providerId, "k-w6", win6);
        await expireWager("w-6");
        const retried = await wagers.process(c.providerId, "k-w6", win6);
        expect(retried.response.status).toBe("REJECTED");
        expect(retried.response.failureCode).toBe("REFERENCE_NOT_FOUND");
        expect(await balance(c.walletId)).toBe("100.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("7. two instances resume the same pending operation: one effect", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const win7 = win(c.externalPlayerId, "w-7", "b-7");
        await wagers.process(c.providerId, "k-w7", win7);
        await wagers.process(
          c.providerId,
          "k-b7",
          ctx.wagerInput(c.externalPlayerId, "b-7", { amount: "10.00" }),
        );
        const results = await Promise.all([
          wagers.process(c.providerId, "k-w7", win7),
          wagers.process(c.providerId, "k-w7", win7),
          wagers.process(c.providerId, "k-w7", win7),
        ]);
        for (const r of results) {
          expect(r.response.status).toBe("PROCESSED");
        }
        expect(await balance(c.walletId)).toBe("140.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("8. a new service instance (restart) resumes the pending operation", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const before = new WagerTransactionsService(ctx.transactionManager);
        const win8 = win(c.externalPlayerId, "w-8", "b-8");
        await before.process(c.providerId, "k-w8", win8);
        await before.process(
          c.providerId,
          "k-b8",
          ctx.wagerInput(c.externalPlayerId, "b-8", { amount: "10.00" }),
        );
        const afterRestart = new WagerTransactionsService(
          ctx.transactionManager,
        );
        const resumed = await afterRestart.process(c.providerId, "k-w8", win8);
        expect(resumed.response.status).toBe("PROCESSED");
        expect(await balance(c.walletId)).toBe("140.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });
    });
  },
);
