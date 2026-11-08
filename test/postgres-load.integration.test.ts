import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  MikroORM,
  type PostgreSqlDriver,
  type EntityManager as PostgreSqlEntityManager,
} from "@mikro-orm/postgresql";
import mikroOrmConfig from "../mikro-orm.config.js";
import { Migration20261106190000 } from "../src/migrations/Migration20261106190000.js";
import { Migration20261106200000 } from "../src/migrations/Migration20261106200000.js";
import { Migration20261106210000 } from "../src/migrations/Migration20261106210000.js";
import { Migration20261107230000 } from "../src/migrations/Migration20261107230000.js";
import { Migration20261108100000 } from "../src/migrations/Migration20261108100000.js";
import { Migration20261108110000 } from "../src/migrations/Migration20261108110000.js";
import { Migration20261108120000 } from "../src/migrations/Migration20261108120000.js";
import { Migration20261108130000 } from "../src/migrations/Migration20261108130000.js";
import { Migration20261108140000 } from "../src/migrations/Migration20261108140000.js";
import { Migration20261108150000 } from "../src/migrations/Migration20261108150000.js";
import { Migration20261108160000 } from "../src/migrations/Migration20261108160000.js";
import { Migration20261109100000 } from "../src/migrations/Migration20261109100000.js";
import { WagerTransactionKind } from "../src/modules/finance/domain/index.js";
import { MikroOrmTransactionManager } from "../src/modules/finance/persistence/index.js";
import { OutboxService } from "../src/modules/outbox/outbox.service.js";
import type { OutboxMessage } from "../src/modules/outbox/types/index.js";
import { WagerTransactionsService } from "../src/modules/transactions/wager-transactions.service.js";

const enabled = process.env.RUN_FINANCIAL_LOAD === "true";
const loadSuite = enabled ? describe : describe.skip;
const schema = `load_finance_${randomUUID().replaceAll("-", "")}`;
const extremeLoadEnabled = process.env.RUN_EXTREME_FINANCIAL_LOAD === "true";

function percentile(samples: readonly number[], percent: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil((percent / 100) * sorted.length) - 1] ?? 0;
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

loadSuite("PostgreSQL financial load and stability", () => {
  let orm: Awaited<
    ReturnType<typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>>
  >;
  let cleanupOrm: Awaited<
    ReturnType<typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>>
  >;
  let transactionManager: MikroOrmTransactionManager;
  let wagers: WagerTransactionsService;
  let outbox: OutboxService;

  beforeAll(async () => {
    cleanupOrm = await MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>(
      mikroOrmConfig,
    );
    await cleanupOrm.em.execute(`CREATE SCHEMA "${schema}"`);
    orm = await MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>({
      ...mikroOrmConfig,
      schema,
      migrations: {
        ...mikroOrmConfig.migrations,
        schema,
        snapshot: false,
        migrationsList: [
          Migration20261106190000,
          Migration20261106200000,
          Migration20261106210000,
          Migration20261107230000,
          Migration20261108100000,
          Migration20261108110000,
          Migration20261108120000,
          Migration20261108130000,
          Migration20261108140000,
          Migration20261108150000,
          Migration20261108160000,
          Migration20261109100000,
        ],
      },
    });
    await orm.migrator.up();
    transactionManager = new MikroOrmTransactionManager(orm.em);
    wagers = new WagerTransactionsService(transactionManager);
    outbox = new OutboxService(transactionManager, {
      publish: async (_message: OutboxMessage) => {},
    });
  });

  afterAll(async () => {
    await orm?.close(true);
    if (cleanupOrm) {
      await cleanupOrm.em.execute(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleanupOrm.close(true);
    }
  });

  async function seedPlayers(playerCount: number): Promise<
    {
      readonly providerId: string;
      readonly playerId: string;
      readonly externalPlayerId: string;
      readonly walletId: string;
      readonly currency: string;
    }[]
  > {
    const providers = Array.from({ length: 4 }, () => ({
      id: randomUUID(),
      code: `load-${randomUUID()}`,
      name: "Financial load provider",
    }));
    const players = Array.from({ length: playerCount }, (_, index) => {
      const provider = providers[index % providers.length];
      if (provider === undefined) {
        throw new Error("Load provider allocation failed");
      }
      const playerId = randomUUID();
      return {
        providerId: provider.id,
        playerId,
        externalPlayerId: `load-player-${index}-${randomUUID()}`,
        walletId: randomUUID(),
        openingId: randomUUID(),
        currency: index % 2 === 0 ? "BRL" : "USD",
      };
    });

    await orm.em.transactional(async (em) => {
      const providerValues: unknown[] = [];
      const providerTuples = providers.map((provider) => {
        providerValues.push(provider.id, provider.code, provider.name);
        return "(?, ?, ?, 'ACTIVE')";
      });
      await em.execute(
        `INSERT INTO "${schema}".providers (id, code, name, status)
         VALUES ${providerTuples.join(", ")}`,
        providerValues,
      );

      for (const batch of chunks(players, 3_000)) {
        const values: unknown[] = [];
        const tuples = batch.map((player) => {
          values.push(
            player.playerId,
            player.providerId,
            player.externalPlayerId,
          );
          return "(?, ?, ?, 'ACTIVE')";
        });
        await em.execute(
          `INSERT INTO "${schema}".players
            (id, provider_id, external_player_id, status)
           VALUES ${tuples.join(", ")}`,
          values,
        );
      }

      for (const batch of chunks(players, 3_000)) {
        const values: unknown[] = [];
        const tuples = batch.map((player) => {
          values.push(
            player.walletId,
            player.providerId,
            player.playerId,
            player.currency,
          );
          return "(?, ?, ?, ?, '0.00', 1)";
        });
        await em.execute(
          `INSERT INTO "${schema}".wallets
            (id, provider_id, player_id, currency, balance, version)
           VALUES ${tuples.join(", ")}`,
          values,
        );
      }

      for (const batch of chunks(players, 3_000)) {
        const values: unknown[] = [];
        const tuples = batch.map((player) => {
          values.push(
            player.openingId,
            player.providerId,
            player.playerId,
            player.walletId,
            player.currency,
          );
          return "(?, ?, ?, ?, 'OPENING', 'PROCESSED', '100.00', ?, now(), now())";
        });
        await em.execute(
          `INSERT INTO "${schema}".wager_transactions
            (id, provider_id, player_id, wallet_id, kind, status, amount,
             currency, processed_at, completed_at)
           VALUES ${tuples.join(", ")}`,
          values,
        );
      }

      for (const batch of chunks(players, 3_000)) {
        const values: unknown[] = [];
        const tuples = batch.map((player) => {
          values.push(player.walletId, player.openingId);
          return "(?::uuid, ?::uuid)";
        });
        await em.execute(
          `UPDATE "${schema}".wallets wallet
           SET balance = '100.00', version = 2,
               balance_transaction_id = pg_current_xact_id(), updated_at = now()
           FROM (VALUES ${tuples.join(", ")}) AS seeded(wallet_id, opening_id)
           WHERE wallet.id = seeded.wallet_id`,
          values,
        );
      }

      await em.execute(
        `INSERT INTO "${schema}".wallet_ledger_entries
          (provider_id, player_id, wallet_id, wager_transaction_id,
           amount, entry_type, balance_before, balance_after)
         SELECT wager.provider_id, wager.player_id, wager.wallet_id, wager.id,
                wager.amount, 'CREDIT', '0.00', '100.00'
         FROM "${schema}".wager_transactions wager
         JOIN "${schema}".wallets wallet ON wallet.id = wager.wallet_id
         WHERE wager.kind = 'OPENING'
           AND wallet.balance_transaction_id = pg_current_xact_id()`,
      );
    });

    return players.map(({ openingId: _openingId, ...player }) => player);
  }

  async function runLoad(playerCount: number): Promise<void> {
    const players = await seedPlayers(playerCount);
    const providerIds = [
      ...new Set(players.map((player) => player.providerId)),
    ];
    const providerPlaceholders = providerIds.map(() => "?").join(", ");
    const providerParameters = providerIds;
    const latencyMs: number[] = [];
    const deadlocksBefore = await databaseDeadlocks();
    let lockWaitSamples = 0;
    let maxClientConnections = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const [sample] = await orm.em.execute<
          { lock_waits: number; client_connections: number }[]
        >(
          `SELECT
             (SELECT count(*)::int FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock') AS lock_waits,
             (SELECT count(*)::int FROM pg_stat_activity
              WHERE datname = current_database()
                AND backend_type = 'client backend') AS client_connections`,
        );
        lockWaitSamples += sample?.lock_waits ?? 0;
        maxClientConnections = Math.max(
          maxClientConnections,
          sample?.client_connections ?? 0,
        );
        await Bun.sleep(50);
      }
    })();

    const startedAt = performance.now();
    const results = await Promise.allSettled(
      players.map(async (player, index) => {
        const requestStartedAt = performance.now();
        const result = await wagers.process(
          player.providerId,
          `load-idempotency-${player.playerId}`,
          {
            externalPlayerId: player.externalPlayerId,
            externalTransactionId: `load-transaction-${player.playerId}`,
            kind: WagerTransactionKind.BET,
            amount: "1.00",
            currency: player.currency,
          },
        );
        latencyMs[index] = performance.now() - requestStartedAt;
        return result;
      }),
    );
    const elapsedMs = performance.now() - startedAt;
    sampling = false;
    await sampler;

    const failures = results.filter((result) => result.status === "rejected");
    const unexpectedStatuses = results.filter(
      (result) =>
        result.status === "fulfilled" &&
        result.value.response.status !== "PROCESSED",
    );
    const deadlocksAfter = await databaseDeadlocks();
    const backlogBeforeDispatch = await outboxCount("PENDING", providerIds);
    const workerStartedAt = performance.now();
    let workerPublished = 0;
    while (true) {
      const batch = await outbox.dispatchBatch(
        `load-worker-${randomUUID()}`,
        1_000,
        30_000,
      );
      workerPublished += batch.published;
      if (batch.failures.length > 0) {
        throw new Error(
          `Outbox load worker failed: ${batch.failures[0]?.error}`,
        );
      }
      if (batch.claimed === 0) {
        break;
      }
    }
    const workerElapsedMs = performance.now() - workerStartedAt;

    const reconciliation = await orm.em.execute<
      {
        wallet_count: string;
        invalid_wallets: string;
        wallet_balance_total: string;
        ledger_balance_total: string;
        opening_count: string;
        processed_bet_count: string;
        ledger_count: string;
        operation_count: string;
        published_outbox_count: string;
        pending_outbox_count: string;
      }[]
    >(
      `SELECT
         count(*)::text AS wallet_count,
         count(*) FILTER (
           WHERE wallet.balance <> '99.00' OR wallet.version <> 3
         )::text AS invalid_wallets,
         COALESCE(sum(wallet.balance), 0)::numeric(20, 2)::text
           AS wallet_balance_total,
         (SELECT COALESCE(sum(signed_entries.balance), 0)
                   ::numeric(20, 2)::text
          FROM (
            SELECT ledger.wallet_id,
                   sum(CASE ledger.entry_type
                         WHEN 'CREDIT' THEN ledger.amount
                         ELSE -ledger.amount
                       END) AS balance
            FROM "${schema}".wallet_ledger_entries ledger
            WHERE ledger.provider_id IN (${providerPlaceholders})
            GROUP BY ledger.wallet_id
          ) signed_entries) AS ledger_balance_total,
         (SELECT count(*)::text FROM "${schema}".wager_transactions
          WHERE provider_id IN (${providerPlaceholders})
            AND kind = 'OPENING') AS opening_count,
         (SELECT count(*)::text FROM "${schema}".wager_transactions
          WHERE provider_id IN (${providerPlaceholders})
            AND kind = 'BET' AND status = 'PROCESSED') AS processed_bet_count,
         (SELECT count(*)::text FROM "${schema}".wallet_ledger_entries
          WHERE provider_id IN (${providerPlaceholders}))
           AS ledger_count,
         (SELECT count(*)::text FROM "${schema}".financial_operations
          WHERE provider_id IN (${providerPlaceholders}))
           AS operation_count,
         (SELECT count(*)::text FROM "${schema}".outbox
          WHERE status = 'PUBLISHED'
            AND aggregate_id IN (
              SELECT id FROM "${schema}".wallets
              WHERE provider_id IN (${providerPlaceholders})
            )
            OR (status = 'PUBLISHED'
              AND aggregate_id IN (
              SELECT id FROM "${schema}".wager_transactions
                WHERE provider_id IN (${providerPlaceholders})
              ))) AS published_outbox_count,
         (SELECT count(*)::text FROM "${schema}".outbox
          WHERE status <> 'PUBLISHED'
            AND aggregate_id IN (
              SELECT id FROM "${schema}".wallets
              WHERE provider_id IN (${providerPlaceholders})
            )
            OR (status <> 'PUBLISHED'
              AND aggregate_id IN (
              SELECT id FROM "${schema}".wager_transactions
                WHERE provider_id IN (${providerPlaceholders})
              ))) AS pending_outbox_count
       FROM "${schema}".wallets wallet
       WHERE wallet.provider_id IN (${providerPlaceholders})`,
      [
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
        ...providerParameters,
      ],
    );

    expect(failures).toHaveLength(0);
    expect(unexpectedStatuses).toHaveLength(0);
    expect(backlogBeforeDispatch).toBe(playerCount * 2);
    expect(workerPublished).toBe(playerCount * 2);
    expect(reconciliation[0]).toEqual({
      wallet_count: String(playerCount),
      invalid_wallets: "0",
      wallet_balance_total: `${playerCount * 99}.00`,
      ledger_balance_total: `${playerCount * 99}.00`,
      opening_count: String(playerCount),
      processed_bet_count: String(playerCount),
      ledger_count: String(playerCount * 2),
      operation_count: String(playerCount),
      published_outbox_count: String(playerCount * 2),
      pending_outbox_count: "0",
    });

    const report = {
      players: playerCount,
      providers: 4,
      throughputPerSecond: Number(
        (playerCount / (elapsedMs / 1_000)).toFixed(2),
      ),
      averageLatencyMs: Number(
        (
          latencyMs.reduce((sum, latency) => sum + latency, 0) /
          latencyMs.length
        ).toFixed(2),
      ),
      p95LatencyMs: Number(percentile(latencyMs, 95).toFixed(2)),
      p99LatencyMs: Number(percentile(latencyMs, 99).toFixed(2)),
      errors: failures.length + unexpectedStatuses.length,
      errorRate: Number(
        ((failures.length + unexpectedStatuses.length) / playerCount).toFixed(
          4,
        ),
      ),
      deadlockDelta: deadlocksAfter - deadlocksBefore,
      lockWaitSamples,
      maxClientConnections,
      outboxBacklogBeforeWorker: backlogBeforeDispatch,
      workerPublished,
      workerElapsedMs: Number(workerElapsedMs.toFixed(2)),
      fullyReconciled: true,
    };
    console.info(`Financial load report: ${JSON.stringify(report)}`);
  }

  async function databaseDeadlocks(): Promise<number> {
    const [row] = await orm.em.execute<{ deadlocks: number }[]>(
      `SELECT deadlocks::int FROM pg_stat_database
       WHERE datname = current_database()`,
    );
    if (row === undefined) {
      throw new Error("Could not read PostgreSQL deadlock statistics");
    }
    return row.deadlocks;
  }

  async function outboxCount(
    status: string,
    providerIds: readonly string[],
  ): Promise<number> {
    const [row] = await orm.em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count FROM "${schema}".outbox
       WHERE status = ?
         AND aggregate_id IN (
           SELECT id FROM "${schema}".wallets
           WHERE provider_id IN (${providerIds.map(() => "?").join(", ")})
         )
         OR (status = ? AND aggregate_id IN (
           SELECT id FROM "${schema}".wager_transactions
           WHERE provider_id IN (${providerIds.map(() => "?").join(", ")})
         ))`,
      [status, ...providerIds, status, ...providerIds],
    );
    return Number(row?.count ?? 0);
  }

  test("loads 100 distinct players across providers and wallets", async () => {
    await runLoad(100);
  }, 120_000);

  test("loads 1,000 distinct players across providers and wallets", async () => {
    await runLoad(1_000);
  }, 180_000);

  if (extremeLoadEnabled) {
    test("loads 10,000 distinct players when explicitly enabled", async () => {
      await runLoad(10_000);
    }, 600_000);
  }
});
