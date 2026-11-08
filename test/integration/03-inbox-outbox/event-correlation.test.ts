import { describe, expect, test } from "bun:test";
import { PendingReferenceRetryService } from "../../../src/modules/transactions/pending-reference-retry.service.js";
import { withCorrelationId } from "../../../src/shared/observability/request-context.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL correlation and causation propagation",
  (ctx) => {
    describe("identifiers stay traceable across the financial flow", () => {
      type OutboxEnvelope = {
        eventType: string;
        correlationId: string;
        causationId?: string;
        aggregateId: string;
      };

      async function envelopesFor(
        transactionId: string,
      ): Promise<OutboxEnvelope[]> {
        const rows = await ctx.orm.em.execute<{ payload: unknown }[]>(
          `SELECT payload FROM "${ctx.schema}".outbox WHERE payload->>'wagerTransactionId' = ?
             OR payload->'data'->>'wagerTransactionId' = ?
             OR aggregate_id = ?::uuid`,
          [transactionId, transactionId, transactionId],
        );
        return rows.map(
          (row) =>
            (typeof row.payload === "string"
              ? JSON.parse(row.payload)
              : row.payload) as OutboxEnvelope,
        );
      }

      async function outboxAll(): Promise<OutboxEnvelope[]> {
        const rows = await ctx.orm.em.execute<{ payload: unknown }[]>(
          `SELECT payload FROM "${ctx.schema}".outbox`,
        );
        return rows.map(
          (row) =>
            (typeof row.payload === "string"
              ? JSON.parse(row.payload)
              : row.payload) as OutboxEnvelope,
        );
      }

      test("HTTP request: the correlation ID reaches every event and no causation is invented", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        await withCorrelationId("corr-http-1", () =>
          wagers.process(
            c.providerId,
            "k-http-1",
            ctx.wagerInput(c.externalPlayerId, "bet-http-1", {
              amount: "10.00",
            }),
          ),
        );
        const events = (await outboxAll()).filter(
          (e) => e.correlationId === "corr-http-1",
        );
        expect(events.map((e) => e.eventType).sort()).toEqual([
          "WagerTransactionProcessed",
          "WalletBalanceChanged",
        ]);
        for (const event of events) {
          expect(event.causationId).toBeUndefined();
        }
      });

      test("resumed pending WIN keeps the original correlation and cites the pending transaction as cause", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const pending = await withCorrelationId("corr-original-win", () =>
          wagers.process(
            c.providerId,
            "k-win-c",
            ctx.wagerInput(c.externalPlayerId, "win-c", {
              kind: WagerTransactionKind.WIN,
              externalReferenceTransactionId: "bet-c",
              amount: "40.00",
            }),
          ),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        const pendingId = pending.response.transaction?.id as string;

        // The BET arrives under another flow entirely.
        await withCorrelationId("corr-bet-c", () =>
          wagers.process(
            c.providerId,
            "k-bet-c",
            ctx.wagerInput(c.externalPlayerId, "bet-c", { amount: "10.00" }),
          ),
        );

        // A worker resumes without any correlation of its own.
        const retry = new PendingReferenceRetryService(
          ctx.transactionManager,
          wagers,
        );
        const resumed = await retry.retry(pendingId);
        expect(resumed?.response.status).toBe("PROCESSED");

        const winEvents = (await envelopesFor(pendingId)).filter(
          (e) => e.eventType === "WagerTransactionProcessed",
        );
        expect(winEvents).toHaveLength(1);
        expect(winEvents[0]?.correlationId).toBe("corr-original-win");
        expect(winEvents[0]?.causationId).toBe(pendingId);
      });

      test("correlation is never derived from the transaction ID when the flow has none", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const result = await wagers.process(
          c.providerId,
          "k-bare",
          ctx.wagerInput(c.externalPlayerId, "bet-bare", { amount: "5.00" }),
        );
        const transactionId = result.response.transaction?.id as string;
        const events = await envelopesFor(transactionId);
        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          expect(event.correlationId).not.toBe(transactionId);
          expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        }
      });
    });
  },
);
