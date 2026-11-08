import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

// The publisher's SQS endpoint is a socket that accepts connections and never
// answers. Publication is then in flight for as long as the test needs, with no
// race: the claimed row stays PROCESSING under its lease.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const outboxTests = enabled ? describe : describe.skip;
const LOCALSTACK =
  process.env.LOCALSTACK_TEST_ENDPOINT ?? "http://127.0.0.1:4566";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for: ${label}`);
  })();
}

function spawnWorker(env: Record<string, string>) {
  const chunks: string[] = [];
  const proc = Bun.spawn(["bun", "src/workers/outbox-worker.ts"], {
    cwd: `${import.meta.dir}/../../..`,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
  };
  void drain(proc.stdout as ReadableStream<Uint8Array>);
  void drain(proc.stderr as ReadableStream<Uint8Array>);
  return { proc, output: () => chunks.join("") };
}

outboxTests("outbox publication in flight across SIGTERM and restart", () => {
  registerPostgresIntegrationSuite("outbox in-flight", (ctx) => {
    test("a stuck publish is bounded by the deadline; the lease is recovered by a restarted publisher", async () => {
      // Events to publish: one BET creates two outbox rows.
      const c = await ctx.seedWagerContext("100.00");
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      await wagers.process(
        c.providerId,
        `k-ob-${randomUUID()}`,
        ctx.wagerInput(c.externalPlayerId, `ob-${randomUUID()}`, {
          kind: WagerTransactionKind.BET,
          amount: "5.00",
        }),
      );

      const blackhole = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data() {},
          open() {},
          close() {},
          error() {},
        },
      });
      const stuckEndpoint = `http://127.0.0.1:${blackhole.port}`;
      const common = {
        POSTGRES_SCHEMA: ctx.schema,
        OUTBOX_POLL_INTERVAL_MS: "50",
        OUTBOX_LEASE_MS: "1000",
        OUTBOX_RETRY_BASE_DELAY_MS: "0",
        OUTBOX_RETRY_MAX_DELAY_MS: "0",
        OUTBOX_MAX_ATTEMPTS: "20",
        SQS_OUTBOX_QUEUE_NAME: "test-queue",
        AWS_REGION: process.env.AWS_REGION ?? "sa-east-1",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
      };

      const stuck = spawnWorker({
        ...common,
        LOCALSTACK_ENDPOINT: stuckEndpoint,
        OUTBOX_METRICS_PORT: String(await freePort()),
        SHUTDOWN_TIMEOUT_MS: "2000",
      });
      try {
        await waitFor(
          async () => {
            const rows = await ctx.orm.em.execute<{ n: number }[]>(
              `SELECT count(*)::int AS n FROM "${ctx.schema}".outbox WHERE status = 'PROCESSING'`,
            );
            return (rows[0]?.n ?? 0) > 0;
          },
          30_000,
          "a claimed, in-flight outbox row",
        );

        // Publication never completes, so SIGTERM cannot drain it. The deadline
        // must end the process, instead of leaving it hung forever.
        stuck.proc.kill("SIGTERM");
        expect(await stuck.proc.exited).toBe(1);
        expect(stuck.output()).toContain("Shutdown deadline reached");

        const inFlight = await ctx.orm.em.execute<
          {
            status: string;
            attempts: number;
            locked_by: string | null;
            published_at: Date | null;
          }[]
        >(
          `SELECT status, attempts, locked_by, published_at FROM "${ctx.schema}".outbox`,
        );
        expect(
          inFlight.some((r) => r.status === "PROCESSING" && r.attempts === 1),
        ).toBe(true);
        expect(inFlight.every((r) => r.published_at === null)).toBe(true);
      } finally {
        stuck.proc.kill("SIGKILL");
      }

      // Restart with the real endpoint. The expired leases are recovered and
      // every event is published exactly once from the publisher's point of view.
      const restarted = spawnWorker({
        ...common,
        LOCALSTACK_ENDPOINT: LOCALSTACK,
        OUTBOX_METRICS_PORT: String(await freePort()),
        SHUTDOWN_TIMEOUT_MS: "5000",
      });
      try {
        await waitFor(
          async () => {
            const rows = await ctx.orm.em.execute<{ n: number }[]>(
              `SELECT count(*)::int AS n FROM "${ctx.schema}".outbox WHERE status <> 'PUBLISHED'`,
            );
            return (rows[0]?.n ?? 0) === 0;
          },
          60_000,
          "all outbox rows published after restart",
        );

        const rows = await ctx.orm.em.execute<
          {
            status: string;
            attempts: number;
            published_at: Date | null;
            failed_at: Date | null;
          }[]
        >(
          `SELECT status, attempts, published_at, failed_at FROM "${ctx.schema}".outbox`,
        );
        expect(rows.length).toBeGreaterThanOrEqual(2);
        expect(
          rows.every(
            (r) => r.status === "PUBLISHED" && r.published_at !== null,
          ),
        ).toBe(true);
        expect(rows.every((r) => r.failed_at === null)).toBe(true);
        // The rows that were in flight at the forced exit were claimed twice.
        expect(rows.some((r) => r.attempts >= 2)).toBe(true);
      } finally {
        restarted.proc.kill("SIGTERM");
        await restarted.proc.exited;
        blackhole.stop(true);
      }
    }, 180_000);
  });
});
