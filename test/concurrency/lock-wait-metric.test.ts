import { describe, expect, test } from "bun:test";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";
import { FinancialMetrics } from "../../src/shared/observability/financial-metrics.js";
import { registerPostgresIntegrationSuite } from "../support/postgres-integration-context.js";
import { WagerTransactionKind } from "../support/postgres-test-dependencies.js";

// Known contention: a transaction holds the wallet lock for HOLD_MS, while a
// BET waits for it. The lock-wait metric must reflect that wait.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const metricTests = enabled ? describe : describe.skip;
const HOLD_MS = 400;

function readSum(metrics: FinancialMetrics) {
  const text = metrics.renderPrometheus();
  const pick = (name: string) =>
    Number(
      text
        .split("\n")
        .find((l) => l.startsWith(`${name} `))
        ?.split(" ")[1] ?? 0,
    );
  return {
    count: pick("financial_lock_wait_milliseconds_count"),
    sum: pick("financial_lock_wait_milliseconds_sum"),
  };
}

metricTests("lock wait metric reflects a known wait", () => {
  registerPostgresIntegrationSuite("lock wait metric", (ctx) => {
    test("a BET blocked for a controlled interval records about that wait", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const metrics = new FinancialMetrics();
      const transactions = new MikroOrmTransactionManager(
        ctx.orm.em,
        3,
        metrics,
      );
      const wagers = new WagerTransactionsService(
        transactions,
        undefined,
        metrics,
      );

      const sql = new Bun.SQL({
        hostname: process.env.POSTGRES_HOST ?? "localhost",
        port: Number(process.env.POSTGRES_PORT ?? "5432"),
        username: process.env.POSTGRES_USER ?? "betting_user",
        password: process.env.POSTGRES_PASSWORD ?? "betting_password",
        database: process.env.POSTGRES_DB ?? "betting_db",
        max: 2,
      });
      const holder = await sql.reserve();
      try {
        // Control phase 1: an uncontended BET. Its locking reads must not wait.
        const quietBefore = readSum(metrics);
        await wagers.process(
          c.providerId,
          "quiet-key",
          ctx.wagerInput(c.externalPlayerId, "quiet-tx", {
            kind: WagerTransactionKind.BET,
            amount: "1.00",
          }),
        );
        const quiet = readSum(metrics);
        const quietSum = quiet.sum - quietBefore.sum;
        expect(quiet.count - quietBefore.count).toBeGreaterThanOrEqual(3);

        // Contended phase: hold the wallet lock, start the BET, wait until it
        // is observably blocked, keep the lock for HOLD_MS, then release.
        await holder.unsafe("BEGIN");
        await holder.unsafe(
          `SELECT 1 FROM "${ctx.schema}".wallets WHERE id = $1 FOR UPDATE`,
          [c.walletId],
        );
        const before = readSum(metrics);
        const blocked = wagers.process(
          c.providerId,
          "held-key",
          ctx.wagerInput(c.externalPlayerId, "held-tx", {
            kind: WagerTransactionKind.BET,
            amount: "1.00",
          }),
        );
        const deadline = Date.now() + 20_000;
        for (;;) {
          const rows = await sql.unsafe(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if (Number(rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error("the BET never blocked");
          await new Promise((r) => setTimeout(r, 20));
        }
        const holdStarted = performance.now();
        await new Promise((r) => setTimeout(r, HOLD_MS));
        await holder.unsafe("COMMIT");
        const held = performance.now() - holdStarted;
        await blocked;
        const after = readSum(metrics);

        const contendedSum = after.sum - before.sum;
        // The wait is at least the held interval, minus scheduling jitter.
        expect(contendedSum).toBeGreaterThanOrEqual(HOLD_MS * 0.8);
        // And it does not exceed the held interval by much: no double count.
        expect(contendedSum).toBeLessThanOrEqual(held + 500);
        // The uncontended BET recorded only its own query time.
        expect(quietSum).toBeLessThan(100);
        console.log(
          `LOCK_WAIT_CHECK ${JSON.stringify({
            holdMs: HOLD_MS,
            measuredContendedSumMs: Math.round(contendedSum),
            measuredUncontendedSumMs: Math.round(quietSum * 100) / 100,
          })}`,
        );
      } finally {
        holder.release();
        await sql.close();
      }
    }, 120_000);
  });
});
