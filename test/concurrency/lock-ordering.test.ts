import { describe, expect, test } from "bun:test";
import { PendingReferenceRetryService } from "../../src/modules/transactions/pending-reference-retry.service.js";
import { registerPostgresIntegrationSuite } from "../support/postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL lock ordering under interleaving",
  (ctx) => {
    describe("settlement paths acquire locks in one order", () => {
      async function makeDue(externalId: string): Promise<void> {
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_transactions
              SET next_reference_attempt_at = now() - interval '1 second'
            WHERE external_transaction_id = ?`,
          [externalId],
        );
      }

      test("resume of a pending WIN x ROLLBACK aimed at that WIN: no persistent deadlock, no partial effect", async () => {
        for (let round = 0; round < 15; round += 1) {
          const c = await ctx.seedWagerContext("100.00");
          const wagers = new WagerTransactionsService(ctx.transactionManager);
          const retry = new PendingReferenceRetryService(
            ctx.transactionManager,
            wagers,
          );
          const winId = `win-lock-${round}`;
          const betId = `bet-lock-${round}`;

          // WIN waits for a BET that does not exist yet.
          await wagers.process(
            c.providerId,
            `k-win-${round}`,
            ctx.wagerInput(c.externalPlayerId, winId, {
              kind: WagerTransactionKind.WIN,
              externalReferenceTransactionId: betId,
              amount: "40.00",
            }),
          );
          await makeDue(winId);
          // The BET arrives, so the resume can finish the WIN.
          await wagers.process(
            c.providerId,
            `k-bet-${round}`,
            ctx.wagerInput(c.externalPlayerId, betId, { amount: "10.00" }),
          );

          // Concurrently: the worker resumes the WIN, and a ROLLBACK that
          // targets the WIN's external ID arrives.
          const outcomes = await Promise.allSettled([
            retry.retry(await winRowId(winId)),
            wagers.process(
              c.providerId,
              `k-rb-${round}`,
              ctx.wagerInput(c.externalPlayerId, `rb-${round}`, {
                kind: WagerTransactionKind.ROLLBACK,
                externalReferenceTransactionId: winId,
                amount: "40.00",
              }),
            ),
          ]);
          for (const outcome of outcomes) {
            expect(outcome.status).toBe("fulfilled");
          }
          await ctx.expectWalletBalanceMatchesLedger(c.walletId);
        }

        async function winRowId(externalId: string): Promise<string> {
          const rows = await ctx.orm.em.execute<{ id: string }[]>(
            `SELECT id FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = ?`,
            [externalId],
          );
          return rows[0]?.id as string;
        }
      }, 120_000);

      test("BET x REFUND on one BET: exactly one settlement, consistent ledger", async () => {
        for (let round = 0; round < 10; round += 1) {
          const c = await ctx.seedWagerContext("100.00");
          const wagers = new WagerTransactionsService(ctx.transactionManager);
          const betId = `bet-r-${round}`;
          await wagers.process(
            c.providerId,
            `k-b-${round}`,
            ctx.wagerInput(c.externalPlayerId, betId, { amount: "10.00" }),
          );
          const results = await Promise.all([
            wagers.process(
              c.providerId,
              `k-r1-${round}`,
              ctx.wagerInput(c.externalPlayerId, `refund-a-${round}`, {
                kind: WagerTransactionKind.REFUND,
                externalReferenceTransactionId: betId,
                amount: "10.00",
              }),
            ),
            wagers.process(
              c.providerId,
              `k-r2-${round}`,
              ctx.wagerInput(c.externalPlayerId, `refund-b-${round}`, {
                kind: WagerTransactionKind.REFUND,
                externalReferenceTransactionId: betId,
                amount: "10.00",
              }),
            ),
          ]);
          expect(
            results.filter((r) => r.response.status === "PROCESSED"),
          ).toHaveLength(1);
          await ctx.expectWalletBalanceMatchesLedger(c.walletId);
        }
      }, 120_000);

      test("BET x ROLLBACK on one BET: the outcome is one of the two valid orders", async () => {
        for (let round = 0; round < 10; round += 1) {
          const c = await ctx.seedWagerContext("100.00");
          const wagers = new WagerTransactionsService(ctx.transactionManager);
          const betId = `bet-x-${round}`;
          const [bet, rollback] = await Promise.all([
            wagers.process(
              c.providerId,
              `k-bx-${round}`,
              ctx.wagerInput(c.externalPlayerId, betId, { amount: "10.00" }),
            ),
            wagers.process(
              c.providerId,
              `k-rx-${round}`,
              ctx.wagerInput(c.externalPlayerId, `rb-x-${round}`, {
                kind: WagerTransactionKind.ROLLBACK,
                externalReferenceTransactionId: betId,
                amount: "10.00",
              }),
            ),
          ]);
          // The ROLLBACK may run before the BET is visible (pending), or after
          // it (processed). Neither may leave a partial effect.
          expect(["PROCESSED", "PENDING_REFERENCE"]).toContain(
            bet.response.status,
          );
          expect(["PROCESSED", "PENDING_REFERENCE", "REJECTED"]).toContain(
            rollback.response.status,
          );
          await ctx.expectWalletBalanceMatchesLedger(c.walletId);
        }
      }, 120_000);
    });
  },
);
