import { describe, expect, test } from "bun:test";
import { OutboxService } from "../../../src/modules/outbox/outbox.service.js";
import type { OutboxMessage } from "../../../src/modules/outbox/types/index.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import { randomUUID } from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL outbox terminal state and redrive",
  (ctx) => {
    describe("bounded publication attempts", () => {
      // Each test works on its own events: every row left by earlier tests is
      // closed as PUBLISHED so the dispatcher only sees what the test created.
      async function isolate(): Promise<void> {
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".outbox
              SET status = 'PUBLISHED', locked_by = NULL, locked_until = NULL,
                  failed_at = NULL, published_at = COALESCE(published_at, now())
            WHERE status <> 'PUBLISHED'`,
        );
      }

      async function createEvent(): Promise<string> {
        const id = randomUUID();
        await ctx.transactionManager.transaction((session) =>
          session.outbox.create({
            id,
            aggregate_id: randomUUID(),
            event_type: "WagerTransactionProcessed",
            payload: { eventType: "WagerTransactionProcessed", version: 1 },
          }),
        );
        return id;
      }

      async function rowOf(id: string) {
        const rows = await ctx.orm.em.execute<
          {
            status: string;
            attempts: number;
            last_error: string | null;
            last_attempt_at: Date | null;
            failed_at: Date | null;
            published_at: Date | null;
            locked_by: string | null;
          }[]
        >(
          `SELECT status, attempts, last_error, last_attempt_at, failed_at, published_at, locked_by
             FROM "${ctx.schema}".outbox WHERE id = ?`,
          [id],
        );
        return rows[0];
      }

      function failingPublisher() {
        const seen: string[] = [];
        return {
          seen,
          publisher: {
            publish: async (message: OutboxMessage): Promise<void> => {
              seen.push(message.eventId);
              throw new Error("SQS unavailable");
            },
          },
        };
      }

      test("1. successful publication marks the event PUBLISHED", async () => {
        await isolate();
        const id = await createEvent();
        const outbox = new OutboxService(
          ctx.transactionManager,
          {
            publish: async () => undefined,
          },
          0,
          0,
          undefined,
          undefined,
          3,
        );
        await outbox.dispatchBatch("worker-ok");
        const row = await rowOf(id);
        expect(row?.status).toBe("PUBLISHED");
        expect(row?.published_at).not.toBeNull();
      });

      test("2. transient failure stays PENDING and records the attempt", async () => {
        await isolate();
        const id = await createEvent();
        const outbox = new OutboxService(
          ctx.transactionManager,
          {
            publish: async () => {
              throw new Error("temporary outage");
            },
          },
          0,
          0,
          undefined,
          undefined,
          3,
        );
        await outbox.dispatchBatch("worker-t");
        const row = await rowOf(id);
        expect(row?.status).toBe("PENDING");
        expect(row?.attempts).toBe(1);
        expect(row?.last_error).toContain("temporary outage");
        expect(row?.last_attempt_at).not.toBeNull();
        expect(row?.failed_at).toBeNull();
      });

      test("3-5. exhausted attempts become a terminal FAILED event that is never claimed again", async () => {
        await isolate();
        const id = await createEvent();
        const { publisher, seen } = failingPublisher();
        const outbox = new OutboxService(
          ctx.transactionManager,
          publisher,
          0,
          0,
          undefined,
          undefined,
          3,
        );

        for (let i = 0; i < 3; i += 1) {
          await outbox.dispatchBatch("worker-x");
        }
        const row = await rowOf(id);
        expect(row?.status).toBe("FAILED");
        expect(row?.attempts).toBe(3);
        expect(row?.failed_at).not.toBeNull();
        expect(row?.last_error).toContain("SQS unavailable");
        expect(row?.locked_by).toBeNull();

        const before = seen.length;
        const next = await outbox.dispatchBatch("worker-x");
        expect(next.claimed).toBe(0);
        expect(seen.length).toBe(before);
        expect((await rowOf(id))?.status).toBe("FAILED");
      });

      test("6. redrive returns FAILED events to PENDING with a fresh attempt budget", async () => {
        await isolate();
        const id = await createEvent();
        const failing = failingPublisher();
        const outbox = new OutboxService(
          ctx.transactionManager,
          failing.publisher,
          0,
          0,
          undefined,
          undefined,
          1,
        );
        await outbox.dispatchBatch("worker-r");
        expect((await rowOf(id))?.status).toBe("FAILED");

        const moved = await outbox.redriveFailed(10);
        expect(moved).toBe(1);
        const after = await rowOf(id);
        expect(after?.status).toBe("PENDING");
        expect(after?.attempts).toBe(0);
        expect(after?.failed_at).toBeNull();
        // The last error is kept for the operator.
        expect(after?.last_error).toContain("SQS unavailable");

        const healthy = new OutboxService(
          ctx.transactionManager,
          {
            publish: async () => undefined,
          },
          0,
          0,
          undefined,
          undefined,
          1,
        );
        await healthy.dispatchBatch("worker-r2");
        expect((await rowOf(id))?.status).toBe("PUBLISHED");
      });

      test("redrive leaves PENDING and PUBLISHED events untouched", async () => {
        await isolate();
        const pendingId = await createEvent();
        const outbox = new OutboxService(
          ctx.transactionManager,
          {
            publish: async () => undefined,
          },
          0,
          0,
          undefined,
          undefined,
          3,
        );
        const moved = await outbox.redriveFailed(10);
        expect(moved).toBe(0);
        expect((await rowOf(pendingId))?.status).toBe("PENDING");
      });

      test("7. two publishers over the same outbox publish an event once", async () => {
        await isolate();
        const id = await createEvent();
        const delivered: string[] = [];
        const publisher = {
          publish: async (message: OutboxMessage): Promise<void> => {
            delivered.push(message.eventId);
          },
        };
        const a = new OutboxService(
          ctx.transactionManager,
          publisher,
          0,
          0,
          undefined,
          undefined,
          3,
        );
        const b = new OutboxService(
          ctx.transactionManager,
          publisher,
          0,
          0,
          undefined,
          undefined,
          3,
        );
        await Promise.all([
          a.dispatchBatch("publisher-a"),
          b.dispatchBatch("publisher-b"),
        ]);
        expect(delivered.filter((x) => x === id)).toHaveLength(1);
        expect((await rowOf(id))?.status).toBe("PUBLISHED");
      });

      test("9-10. a stale lease cannot mark an event FAILED or PUBLISHED (fencing)", async () => {
        await isolate();
        const id = await createEvent();
        // Worker A claims the event, then its lease expires without a
        // heartbeat. Worker B reclaims it.
        await ctx.transactionManager.transaction((session) =>
          session.outbox.claimDue("worker-a", 1, 60_000),
        );
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".outbox SET locked_until = now() - interval '1 second' WHERE id = ?`,
          [id],
        );
        await ctx.transactionManager.transaction((session) =>
          session.outbox.recoverExpiredLeases(),
        );
        const claimedByB = await ctx.transactionManager.transaction((session) =>
          session.outbox.claimDue("worker-b", 1, 60_000),
        );
        expect(claimedByB.map((r) => r.id)).toContain(id);

        // A wakes up and tries to finish with the stale token.
        const staleExhausted = await ctx.transactionManager.transaction(
          (session) =>
            session.outbox.scheduleRetry(
              id,
              "worker-a",
              "late",
              new Date(),
              true,
            ),
        );
        const stalePublished = await ctx.transactionManager.transaction(
          (session) => session.outbox.markPublished(id, "worker-a", new Date()),
        );
        expect(staleExhausted).toBe(false);
        expect(stalePublished).toBe(false);
        const row = await rowOf(id);
        expect(row?.status).toBe("PROCESSING");
        expect(row?.locked_by).toBe("worker-b");
      });

      test("8. crash after publish and before acknowledgement is recovered by another worker", async () => {
        await isolate();
        const id = await createEvent();
        const delivered: string[] = [];
        const publisher = {
          publish: async (message: OutboxMessage): Promise<void> => {
            delivered.push(message.eventId);
          },
        };
        // Worker A claims and publishes, then dies before marking the row.
        await ctx.transactionManager.transaction((session) =>
          session.outbox.claimDue("worker-crash", 1, 60_000),
        );
        await publisher.publish({
          eventId: id,
          eventType: "WagerTransactionProcessed",
          aggregateId: randomUUID(),
          payload: { eventType: "WagerTransactionProcessed", version: 1 },
        });
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".outbox SET locked_until = now() - interval '1 second' WHERE id = ?`,
          [id],
        );
        const survivor = new OutboxService(
          ctx.transactionManager,
          publisher,
          0,
          0,
          undefined,
          undefined,
          3,
        );
        await survivor.dispatchBatch("worker-survivor");
        expect((await rowOf(id))?.status).toBe("PUBLISHED");
        // At-least-once: the event was delivered twice; consumers deduplicate.
        expect(delivered.filter((x) => x === id)).toHaveLength(2);
      });

      test("the database rejects FAILED without a failure timestamp", async () => {
        await isolate();
        const id = await createEvent();
        let message = "";
        try {
          await ctx.orm.em.execute(
            `UPDATE "${ctx.schema}".outbox SET status = 'FAILED' WHERE id = ?`,
            [id],
          );
        } catch (error) {
          message = String(error);
        }
        expect(message).toContain("ck_outbox_failed_state");
      });
    });
  },
);
