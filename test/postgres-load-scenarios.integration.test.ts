import { describe, expect, test } from "bun:test";
import { MikroOrmTransactionManager } from "../src/modules/finance/persistence/index.js";
import { OutboxService } from "../src/modules/outbox/outbox.service.js";
import { WagerTransactionsService } from "../src/modules/transactions/wager-transactions.service.js";
import { FinancialMetrics } from "../src/shared/observability/financial-metrics.js";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  randomUUID,
  WagerTransactionKind,
} from "./postgres-test-dependencies.js";

// Load scenarios. They run only when RUN_FINANCIAL_LOAD=true, and every run
// prints one LOAD_REPORT line with the measured numbers.
//
// Measurement notes, stated up front:
// - Client and server share one machine and one Docker host, so CPU numbers
//   describe the whole environment, not a production capacity figure.
// - Latency is measured around wagers.process, so it includes time waiting for
//   a pooled database connection, not only the server-side work.
// - financial_lock_wait_milliseconds is read from FinancialMetrics, which is
//   fed by the repository layer through the same transaction manager.

const enabled = process.env.RUN_FINANCIAL_LOAD === "true";
const loadTests = enabled ? describe : describe.skip;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

/** Runs `tasks` with at most `concurrency` in flight; returns per-task latency. */
async function runBounded<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<{ latencies: number[]; errors: number; results: T[] }> {
  const latencies: number[] = [];
  const results: T[] = [];
  let errors = 0;
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      const started = performance.now();
      try {
        results.push(await tasks[index]?.());
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - started);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { latencies: latencies.sort((a, b) => a - b), errors, results };
}

loadTests("financial load scenarios", () => {
  registerPostgresIntegrationSuite("load scenarios", (ctx) => {
    // The harness exposes the ORM only after registration, so the services
    // are built inside each test.
    const metrics = new FinancialMetrics();
    let transactions!: MikroOrmTransactionManager;
    let wagers!: WagerTransactionsService;
    const init = () => {
      transactions = new MikroOrmTransactionManager(ctx.orm.em, 3, metrics);
      wagers = new WagerTransactionsService(transactions, undefined, metrics);
    };

    async function deadlocks(): Promise<number> {
      const rows = await ctx.orm.em.execute<{ deadlocks: number }[]>(
        `SELECT deadlocks::int FROM pg_stat_database WHERE datname = current_database()`,
      );
      return rows[0]?.deadlocks ?? 0;
    }

    function lockWaitFromMetrics(): {
      count: number;
      sumMs: number;
      maxMs: number;
    } {
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
        sumMs: pick("financial_lock_wait_milliseconds_sum"),
        maxMs: pick("financial_lock_wait_milliseconds_max"),
      };
    }

    function report(name: string, data: Record<string, unknown>) {
      console.log(`LOAD_REPORT ${JSON.stringify({ scenario: name, ...data })}`);
    }

    async function drainOutbox(outbox: OutboxService): Promise<number> {
      let published = 0;
      for (;;) {
        const batch = await outbox.dispatchBatch(
          `load-${randomUUID()}`,
          500,
          30_000,
        );
        published += batch.published;
        if (batch.failures.length > 0)
          throw new Error(batch.failures[0]?.error);
        if (batch.claimed === 0) return published;
      }
    }

    test("A: hot wallet, every request competes for one balance", async () => {
      init();
      const c = await ctx.seedWagerContext("1000.00");
      const requests = 400;
      const before = await deadlocks();
      const lockBefore = lockWaitFromMetrics();
      const cpuBefore = process.cpuUsage();
      const started = performance.now();
      const run = await runBounded(
        Array.from(
          { length: requests },
          (_, i) => () =>
            wagers.process(
              c.providerId,
              `hot-${i}`,
              ctx.wagerInput(c.externalPlayerId, `hot-tx-${i}`, {
                kind: WagerTransactionKind.BET,
                amount: "1.00",
              }),
            ),
        ),
        50,
      );
      const elapsed = performance.now() - started;
      const lock = lockWaitFromMetrics();
      const cpu = process.cpuUsage(cpuBefore);
      const processed = run.results.filter(
        (r) => r.response.status === "PROCESSED",
      ).length;
      const wallet = await transactions.transaction((s) =>
        s.wallets.findById(c.walletId),
      );
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      report("A-hot-wallet", {
        requests,
        concurrency: 50,
        throughputPerSecond: Math.round((requests / elapsed) * 1000),
        p50Ms: percentile(run.latencies, 50),
        p95Ms: percentile(run.latencies, 95),
        p99Ms: percentile(run.latencies, 99),
        errors: run.errors,
        processed,
        finalBalance: wallet?.balance,
        deadlockDelta: (await deadlocks()) - before,
        lockWaitSamples: lock.count - lockBefore.count,
        lockWaitSumMs: Math.round((lock.sumMs - lockBefore.sumMs) * 100) / 100,
        lockWaitMaxMs: lock.maxMs,
        processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
        heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      });
      expect(run.errors).toBe(0);
      expect(processed).toBe(requests);
      expect(wallet?.balance).toBe("600.00");
    }, 300_000);

    test("B: many wallets, independent operations", async () => {
      init();
      const players = 1000;
      const seeded: Array<{
        providerId: string;
        externalPlayerId: string;
        walletId: string;
      }> = [];
      for (let i = 0; i < players; i += 1) {
        const c = await ctx.seedWagerContext("100.00");
        seeded.push({
          providerId: c.providerId,
          externalPlayerId: c.externalPlayerId,
          walletId: c.walletId,
        });
      }
      const before = await deadlocks();
      const lockBefore = lockWaitFromMetrics();
      const started = performance.now();
      const run = await runBounded(
        seeded.map(
          (p, i) => () =>
            wagers.process(
              p.providerId,
              `many-${i}`,
              ctx.wagerInput(p.externalPlayerId, `many-tx-${i}`, {
                kind: WagerTransactionKind.BET,
                amount: "10.00",
              }),
            ),
        ),
        100,
      );
      const elapsed = performance.now() - started;
      const lock = lockWaitFromMetrics();
      const processed = run.results.filter(
        (r) => r.response.status === "PROCESSED",
      ).length;
      for (const p of seeded.slice(0, 50)) {
        await ctx.expectWalletBalanceMatchesLedger(p.walletId);
      }
      report("B-many-wallets", {
        requests: players,
        concurrency: 100,
        throughputPerSecond: Math.round((players / elapsed) * 1000),
        p50Ms: percentile(run.latencies, 50),
        p95Ms: percentile(run.latencies, 95),
        p99Ms: percentile(run.latencies, 99),
        errors: run.errors,
        processed,
        deadlockDelta: (await deadlocks()) - before,
        lockWaitSamples: lock.count - lockBefore.count,
        lockWaitSumMs: Math.round((lock.sumMs - lockBefore.sumMs) * 100) / 100,
        lockWaitMaxMs: lock.maxMs,
        heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      });
      expect(run.errors).toBe(0);
      expect(processed).toBe(players);
    }, 600_000);

    test("C: four providers, mixed BET/WIN/LOSS/REFUND/ROLLBACK, with concurrent publishers", async () => {
      init();
      const players = 200;
      const seeded: Array<{
        providerId: string;
        externalPlayerId: string;
        walletId: string;
        key: string;
      }> = [];
      for (let i = 0; i < players; i += 1) {
        const c = await ctx.seedWagerContext("500.00");
        seeded.push({
          providerId: c.providerId,
          externalPlayerId: c.externalPlayerId,
          walletId: c.walletId,
          key: `c-${i}`,
        });
      }
      const outbox = new OutboxService(
        transactions,
        { publish: async () => undefined },
        0,
        0,
        metrics,
        undefined,
        20,
      );
      const before = await deadlocks();
      const lockBefore = lockWaitFromMetrics();
      const started = performance.now();
      // Each player runs its own sequence in order: BET, WIN, LOSS, and a
      // reversal of the BET for a quarter of them and a ROLLBACK of the WIN
      // for another quarter. Players run concurrently with each other.
      const opLatencies: number[] = [];
      const timed =
        <T>(fn: () => Promise<T>) =>
        async () => {
          const at = performance.now();
          try {
            return await fn();
          } finally {
            opLatencies.push(performance.now() - at);
          }
        };
      const playerTasks = seeded.map((p, i) => async () => {
        const t = (k: string) => `${p.key}-${k}`;
        const outcomes: Array<{ response: { status: string } }> = [];
        const steps: Array<() => Promise<{ response: { status: string } }>> = [
          () =>
            wagers.process(
              p.providerId,
              `${t("bet")}-k`,
              ctx.wagerInput(p.externalPlayerId, t("bet"), {
                kind: WagerTransactionKind.BET,
                amount: "20.00",
              }),
            ),
          () =>
            wagers.process(
              p.providerId,
              `${t("win")}-k`,
              ctx.wagerInput(p.externalPlayerId, t("win"), {
                kind: WagerTransactionKind.WIN,
                amount: "35.00",
                externalReferenceTransactionId: t("bet"),
              }),
            ),
          // Each BET gets exactly one result: the first BET is won, a second
          // BET is lost, and (below) a third BET is refunded.
          () =>
            wagers.process(
              p.providerId,
              `${t("bet-lost")}-k`,
              ctx.wagerInput(p.externalPlayerId, t("bet-lost"), {
                kind: WagerTransactionKind.BET,
                amount: "5.00",
              }),
            ),
          () =>
            wagers.process(
              p.providerId,
              `${t("loss")}-k`,
              ctx.wagerInput(p.externalPlayerId, t("loss"), {
                kind: WagerTransactionKind.LOSS,
                amount: "5.00",
                externalReferenceTransactionId: t("bet-lost"),
              }),
            ),
        ];
        if (i % 4 === 0) {
          steps.push(
            () =>
              wagers.process(
                p.providerId,
                `${t("bet-refunded")}-k`,
                ctx.wagerInput(p.externalPlayerId, t("bet-refunded"), {
                  kind: WagerTransactionKind.BET,
                  amount: "20.00",
                }),
              ),
            () =>
              wagers.process(
                p.providerId,
                `${t("refund")}-k`,
                ctx.wagerInput(p.externalPlayerId, t("refund"), {
                  kind: WagerTransactionKind.REFUND,
                  amount: "20.00",
                  externalReferenceTransactionId: t("bet-refunded"),
                }),
              ),
          );
        }
        if (i % 4 === 1) {
          steps.push(() =>
            wagers.process(
              p.providerId,
              `${t("rollback")}-k`,
              ctx.wagerInput(p.externalPlayerId, t("rollback"), {
                kind: WagerTransactionKind.ROLLBACK,
                amount: "35.00",
                externalReferenceTransactionId: t("win"),
              }),
            ),
          );
        }
        for (const step of steps) {
          outcomes.push(await timed(step)());
        }
        return outcomes;
      });
      const sequence = playerTasks;
      // Publishers run concurrently with the workload.
      let publishing = true;
      const publisher = (async () => {
        let published = 0;
        while (publishing) {
          const batch = await outbox.dispatchBatch(
            `pub-${randomUUID()}`,
            100,
            30_000,
          );
          published += batch.published;
          if (batch.claimed === 0) await Bun.sleep(20);
        }
        return published;
      })();
      const run = await runBounded(sequence, 60);
      const flat = run.results.flat();
      const elapsed = performance.now() - started;
      publishing = false;
      const publishedConcurrently = await publisher;
      const finalPublished = await drainOutbox(outbox);
      const lock = lockWaitFromMetrics();
      const rejected = flat.filter(
        (r) => r.response.status === "REJECTED",
      ).length;
      const operations = flat.length;
      const latencySorted = [...opLatencies].sort((a, b) => a - b);
      for (const p of seeded) {
        await ctx.expectWalletBalanceMatchesLedger(p.walletId);
      }
      const pending = await ctx.orm.em.execute<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${ctx.schema}".outbox WHERE status <> 'PUBLISHED'`,
      );
      report("C-multi-provider-mixed", {
        requests: operations,
        players,
        providers: 4,
        concurrency: 60,
        throughputPerSecond: Math.round((operations / elapsed) * 1000),
        p50Ms: percentile(latencySorted, 50),
        p95Ms: percentile(latencySorted, 95),
        p99Ms: percentile(latencySorted, 99),
        errors: run.errors,
        playerSequenceErrors: run.errors,
        rejectedBusinessRules: rejected,
        deadlockDelta: (await deadlocks()) - before,
        lockWaitSamples: lock.count - lockBefore.count,
        lockWaitSumMs: Math.round((lock.sumMs - lockBefore.sumMs) * 100) / 100,
        lockWaitMaxMs: lock.maxMs,
        publishedConcurrently,
        publishedAfterDrain: finalPublished,
        outboxNotPublished: pending[0]?.n ?? -1,
        heapMb: Math.round(process.memoryUsage().heapUsed / 1e6),
      });
      expect(run.errors).toBe(0);
      expect(pending[0]?.n).toBe(0);
    }, 900_000);
  });
});
