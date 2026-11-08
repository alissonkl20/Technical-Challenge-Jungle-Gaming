import { describe, expect, test } from "bun:test";
import { ConfigService } from "@nestjs/config";
import { validateEnvironment } from "../src/config/env.validation.js";
import { PermanentReferenceError } from "../src/modules/transactions/errors/index.js";
import type { PendingReferenceRetryService } from "../src/modules/transactions/pending-reference-retry.service.js";
import { PendingReferenceWorkerService } from "../src/modules/transactions/pending-reference-worker.service.js";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL FAILED state for pending references",
  (ctx) => {
    describe("FAILED is reserved for permanent reference errors", () => {
      const configuration = new ConfigService(
        validateEnvironment({
          PENDING_REFERENCE_INITIAL_DELAY_MS: "1000",
        }),
      );

      async function seedPendingWin(
        player: string,
        externalId: string,
        reference: string,
      ) {
        const c = await ctx.seedWagerContext("100.00");
        return { c, externalId, reference, player };
      }

      async function makeDue(externalId: string): Promise<void> {
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_transactions
              SET next_reference_attempt_at = now() - interval '1 second'
            WHERE external_transaction_id = ?`,
          [externalId],
        );
      }

      async function rowOf(externalId: string) {
        const rows = await ctx.orm.em.execute<
          {
            id: string;
            status: string;
            failure_code: string | null;
            completed_at: Date | null;
            reference_attempts: number;
            financial_operation_id: string;
          }[]
        >(
          `SELECT id, status, failure_code, completed_at, reference_attempts, financial_operation_id
             FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = ?`,
          [externalId],
        );
        return rows[0];
      }

      test("permanent error ends in FAILED, is auditable, and completes the operation", async () => {
        const { c } = await seedPendingWin("p", "win-f1", "bet-f1");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const pending = await wagers.process(
          c.providerId,
          "k-f1",
          ctx.wagerInput(c.externalPlayerId, "win-f1", {
            kind: WagerTransactionKind.WIN,
            externalReferenceTransactionId: "bet-f1",
            amount: "30.00",
          }),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        await makeDue("win-f1");

        const stub = {
          retry: async () => {
            throw new PermanentReferenceError("inconsistent stored context");
          },
        } as unknown as PendingReferenceRetryService;
        const worker = new PendingReferenceWorkerService(
          ctx.transactionManager,
          stub,
          configuration,
        );
        const result = await worker.processDue(10);
        expect(result.failed).toBe(1);

        const row = await rowOf("win-f1");
        expect(row?.status).toBe("FAILED");
        expect(row?.failure_code).toBe("INTERNAL_INCONSISTENCY");
        expect(row?.completed_at).not.toBeNull();

        const op = await ctx.orm.em.execute<
          {
            completed_at: Date | null;
            response_http_status: number;
            response_snapshot: unknown;
          }[]
        >(
          `SELECT completed_at, response_http_status, response_snapshot
             FROM "${ctx.schema}".financial_operations WHERE id = ?`,
          [row?.financial_operation_id],
        );
        expect(op[0]?.completed_at).not.toBeNull();
        expect(op[0]?.response_http_status).toBe(500);

        // The FAILED transaction is never picked up again.
        const again = await worker.processDue(10);
        expect(again.examined).toBe(0);
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("a replay of the failed operation returns the final FAILED response", async () => {
        const { c } = await seedPendingWin("p", "win-f2", "bet-f2");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const win = ctx.wagerInput(c.externalPlayerId, "win-f2", {
          kind: WagerTransactionKind.WIN,
          externalReferenceTransactionId: "bet-f2",
          amount: "30.00",
        });
        await wagers.process(c.providerId, "k-f2", win);
        await makeDue("win-f2");
        const stub = {
          retry: async () => {
            throw new PermanentReferenceError("inconsistent");
          },
        } as unknown as PendingReferenceRetryService;
        await new PendingReferenceWorkerService(
          ctx.transactionManager,
          stub,
          configuration,
        ).processDue(10);

        const replay = await wagers.process(c.providerId, "k-f2", win);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.response.status).toBe("FAILED");
        expect(replay.response.failureCode).toBe("INTERNAL_INCONSISTENCY");
      });

      test("a transient error keeps the transaction pending with backoff, not FAILED", async () => {
        const { c } = await seedPendingWin("p", "win-f3", "bet-f3");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        await wagers.process(
          c.providerId,
          "k-f3",
          ctx.wagerInput(c.externalPlayerId, "win-f3", {
            kind: WagerTransactionKind.WIN,
            externalReferenceTransactionId: "bet-f3",
            amount: "30.00",
          }),
        );
        await makeDue("win-f3");
        const stub = {
          retry: async () => {
            throw new Error("connection reset");
          },
        } as unknown as PendingReferenceRetryService;
        const result = await new PendingReferenceWorkerService(
          ctx.transactionManager,
          stub,
          configuration,
        ).processDue(10);
        expect(result.failed).toBe(0);
        const row = await rowOf("win-f3");
        expect(row?.status).toBe("PENDING_REFERENCE");
        expect(row?.reference_attempts).toBe(1);
        expect(row?.completed_at).toBeNull();
      });

      test("the database forbids moving a FAILED transaction to any other state", async () => {
        const { c } = await seedPendingWin("p", "win-f4", "bet-f4");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        await wagers.process(
          c.providerId,
          "k-f4",
          ctx.wagerInput(c.externalPlayerId, "win-f4", {
            kind: WagerTransactionKind.WIN,
            externalReferenceTransactionId: "bet-f4",
            amount: "30.00",
          }),
        );
        await makeDue("win-f4");
        const stub = {
          retry: async () => {
            throw new PermanentReferenceError("inconsistent");
          },
        } as unknown as PendingReferenceRetryService;
        await new PendingReferenceWorkerService(
          ctx.transactionManager,
          stub,
          configuration,
        ).processDue(10);
        let message = "";
        try {
          await ctx.orm.em.execute(
            `UPDATE "${ctx.schema}".wager_transactions SET status = 'PROCESSED', processed_at = now()
              WHERE external_transaction_id = 'win-f4'`,
          );
        } catch (error) {
          message = String(error);
        }
        expect(message).toContain("terminal wager transactions are immutable");
        expect((await rowOf("win-f4"))?.status).toBe("FAILED");
      });
    });
  },
);
