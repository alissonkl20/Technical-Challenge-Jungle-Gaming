import { afterAll, beforeAll, describe, expect } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  MikroORM,
  type PostgreSqlDriver,
  type EntityManager as PostgreSqlEntityManager,
} from "@mikro-orm/postgresql";
import { default as mikroOrmConfig } from "../mikro-orm.config.js";
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
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../src/modules/finance/domain/index.js";
import { MikroOrmTransactionManager } from "../src/modules/finance/persistence/index.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const integration = enabled ? describe : describe.skip;

type IntegrationOrm = Awaited<
  ReturnType<typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>>
>;

type WagerInput = {
  externalPlayerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  externalReferenceTransactionId?: string;
  roundId?: string;
};

type SeededWagerContext = {
  providerId: string;
  playerId: string;
  walletId: string;
  externalPlayerId: string;
};

export interface PostgresIntegrationContext {
  readonly orm: IntegrationOrm;
  readonly transactionManager: MikroOrmTransactionManager;
  readonly cleanupOrm: IntegrationOrm;
  readonly schema: string;
  readonly seedWagerContext: (balance?: string) => Promise<SeededWagerContext>;
  readonly wagerInput: (
    externalPlayerId: string,
    externalTransactionId: string,
    overrides?: Partial<
      Omit<WagerInput, "externalPlayerId" | "externalTransactionId">
    >,
  ) => WagerInput;
  readonly expectWalletBalanceMatchesLedger: (
    walletId: string,
  ) => Promise<void>;
  /**
   * Credits `amount` through the public contract: a 0.01 BET settled by a WIN
   * of `amount + 0.01` that references it. A WIN must name its BET, so this is
   * the valid way to add winnings to an already-open wallet. Adds two Ledger
   * entries (DEBIT 0.01, CREDIT amount + 0.01).
   */
  readonly fundWallet: (
    wagers: {
      process: (
        providerId: string,
        idempotencyKey: string,
        input: WagerInput,
      ) => Promise<{ response: { status: string } }>;
    },
    providerId: string,
    externalPlayerId: string,
    amount: string,
  ) => Promise<void>;
  readonly runWagerInChildProcess: (input: {
    readonly providerId: string;
    readonly idempotencyKey: string;
    readonly wager: WagerInput;
  }) => Promise<{
    readonly pid: number;
    readonly status: string;
    readonly transactionId: string | null;
  }>;
  readonly runSqsEventWorkerProcess: (
    mode: "crash-after-commit" | "consume",
    queueName: string,
  ) => Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly runSqsWagerCommandWorkerProcess: (
    mode: "crash-after-wager-commit" | "consume-wager",
    queueName: string,
    deadLetterQueueName: string,
  ) => Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly findAvailableHttpPort: () => Promise<number>;
  readonly waitForHttpApi: (
    url: string,
    child: ReturnType<typeof spawn>,
  ) => Promise<void>;
  readonly runHttpApiWorkerProcess: (
    port: number,
    providerCode: string,
    apiKey: string,
    postgresPort?: number,
    additionalProviderCredentials?: Readonly<Record<string, string>>,
    additionalEnvironment?: Readonly<Record<string, string>>,
  ) => ReturnType<typeof spawn>;
}

export function registerPostgresIntegrationSuite(
  suiteName: string,
  register: (context: PostgresIntegrationContext) => void,
): void {
  const schema = `it_finance_${randomUUID().replaceAll("-", "")}`;
  integration(suiteName, () => {
    let orm: Awaited<
      ReturnType<
        typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>
      >
    >;
    let transactionManager: MikroOrmTransactionManager;
    let cleanupOrm: Awaited<
      ReturnType<
        typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>
      >
    >;

    beforeAll(async () => {
      cleanupOrm = await MikroORM.init<
        PostgreSqlDriver,
        PostgreSqlEntityManager
      >(mikroOrmConfig);
      await cleanupOrm.em.execute(`CREATE SCHEMA "${schema}"`);
      orm = await MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>({
        ...mikroOrmConfig,
        schema,
        migrations: {
          ...mikroOrmConfig.migrations,
          schema,
          // Each test file migrates its own throwaway schema; writing the
          // snapshot here would leak those schemas into the committed file.
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
    });

    // The challenge's final invariant, checked for every wallet each suite
    // created: the stored balance equals the balance rebuilt from the Ledger.
    afterAll(async () => {
      try {
        // A suite may end with every migration reverted; then there is no
        // wallet left to check.
        const walletsTable =
          orm === undefined
            ? []
            : await orm.em.execute<{ name: string | null }[]>(
                `SELECT to_regclass('"${schema}".wallets')::text AS name`,
              );
        if (orm !== undefined && walletsTable[0]?.name != null) {
          const divergent = await orm.em.execute<
            { id: string; balance: string; ledger_balance: string }[]
          >(
            `SELECT wallet.id,
                  wallet.balance::text AS balance,
                  COALESCE(
                    SUM(
                      CASE entry.entry_type
                        WHEN 'CREDIT' THEN entry.amount
                        ELSE -entry.amount
                      END
                    ),
                    0
                  )::numeric(20, 2)::text AS ledger_balance
           FROM "${schema}".wallets wallet
           LEFT JOIN "${schema}".wallet_ledger_entries entry
             ON entry.wallet_id = wallet.id
           GROUP BY wallet.id
           HAVING wallet.balance <> COALESCE(
             SUM(
               CASE entry.entry_type
                 WHEN 'CREDIT' THEN entry.amount
                 ELSE -entry.amount
               END
             ),
             0
           )`,
          );
          expect(divergent).toEqual([]);
        }
      } finally {
        await orm?.close(true);
        if (cleanupOrm) {
          await cleanupOrm.em.execute(
            `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
          );
          await cleanupOrm.close(true);
        }
      }
    });

    async function seedWagerContext(balance = "100.00") {
      const ids = {
        providerId: randomUUID(),
        playerId: randomUUID(),
        walletId: randomUUID(),
      };
      await transactionManager.transaction(async (session) => {
        await session.providers.create({
          id: ids.providerId,
          code: `wager-${randomUUID()}`,
          name: "Wager Integration Provider",
          status: "ACTIVE",
        });
        await session.players.create({
          id: ids.playerId,
          provider_id: ids.providerId,
          external_player_id: `wager-player-${randomUUID()}`,
          status: "ACTIVE",
        });
        await session.wallets.create({
          id: ids.walletId,
          provider_id: ids.providerId,
          player_id: ids.playerId,
          currency: "BRL",
          balance: "0.00",
          version: 1,
        });
      });
      if (balance !== "0.00") {
        const opening = WagerTransaction.createOpening({
          id: randomUUID(),
          providerId: ids.providerId,
          playerId: ids.playerId,
          walletId: ids.walletId,
          amount: balance,
          currency: "BRL",
        });
        opening.markProcessed();
        const snapshot = opening.snapshot();
        const openingAt = new Date(snapshot.processedAt ?? snapshot.createdAt);
        await transactionManager.transaction(async (session) => {
          await session.wagerTransactions.create({
            id: snapshot.id,
            provider_id: snapshot.providerId,
            player_id: snapshot.playerId,
            wallet_id: snapshot.walletId,
            financial_operation_id: null,
            external_transaction_id: null,
            external_reference_transaction_id: null,
            reference_transaction_id: null,
            round_id: null,
            game_id: null,
            kind: snapshot.kind,
            status: snapshot.status,
            amount: snapshot.amount,
            currency: snapshot.currency,
            failure_code: null,
            reference_attempts: 0,
            next_reference_attempt_at: null,
            reference_expires_at: null,
            processed_at: openingAt,
            completed_at: openingAt,
          });
          const updated = await session.wallets.updateBalance(
            ids.walletId,
            1,
            snapshot.amount,
          );
          if (updated === null) {
            throw new Error("Could not apply test wallet opening balance");
          }
          await session.walletLedger.create({
            id: randomUUID(),
            provider_id: ids.providerId,
            player_id: ids.playerId,
            wallet_id: ids.walletId,
            wager_transaction_id: snapshot.id,
            amount: snapshot.amount,
            entry_type: "CREDIT",
            balance_before: "0.00",
            balance_after: snapshot.amount,
          });
        });
        await expectWalletBalanceMatchesLedger(ids.walletId);
      }
      const player = await transactionManager.transaction((session) =>
        session.players.findById(ids.playerId),
      );
      if (player === null) {
        throw new Error("Seeded player was not persisted");
      }
      return { ...ids, externalPlayerId: player.external_player_id };
    }

    function wagerInput(
      externalPlayerId: string,
      externalTransactionId: string,
      overrides: Partial<{
        kind: WagerTransactionKind;
        amount: string;
        currency: string;
        externalReferenceTransactionId: string;
        roundId: string;
      }> = {},
    ) {
      return {
        externalPlayerId,
        externalTransactionId,
        kind: WagerTransactionKind.BET,
        amount: "10.00",
        currency: "BRL",
        ...overrides,
      };
    }

    async function fundWallet(
      wagers: {
        process: (
          providerId: string,
          idempotencyKey: string,
          input: WagerInput,
        ) => Promise<{ response: { status: string } }>;
      },
      providerId: string,
      externalPlayerId: string,
      amount: string,
    ): Promise<void> {
      const id = `funding-${randomUUID()}`;
      const [whole = "0", fraction = "00"] = amount.split(".");
      const credit =
        BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")) + 1n;
      const winAmount = `${credit / 100n}.${(credit % 100n).toString().padStart(2, "0")}`;
      const stake = await wagers.process(
        providerId,
        `${id}-stake`,
        wagerInput(externalPlayerId, `${id}-stake`, { amount: "0.01" }),
      );
      const win = await wagers.process(
        providerId,
        `${id}-win`,
        wagerInput(externalPlayerId, `${id}-win`, {
          kind: WagerTransactionKind.WIN,
          amount: winAmount,
          externalReferenceTransactionId: `${id}-stake`,
        }),
      );
      if (
        stake.response.status !== "PROCESSED" ||
        win.response.status !== "PROCESSED"
      ) {
        throw new Error(
          `Wallet funding failed: ${stake.response.status}/${win.response.status}`,
        );
      }
    }

    async function expectWalletBalanceMatchesLedger(
      walletId: string,
    ): Promise<void> {
      const rows = await orm.em.execute<
        { balance: string; ledger_balance: string }[]
      >(
        `SELECT wallet.balance::text AS balance,
              COALESCE(
                SUM(
                  CASE entry.entry_type
                    WHEN 'CREDIT' THEN entry.amount
                    ELSE -entry.amount
                  END
                ),
                0
              )::numeric(20, 2)::text AS ledger_balance
       FROM "${schema}".wallets wallet
       LEFT JOIN "${schema}".wallet_ledger_entries entry
         ON entry.wallet_id = wallet.id
       WHERE wallet.id = ?
       GROUP BY wallet.id`,
        [walletId],
      );
      expect(rows[0]?.balance).toBe(rows[0]?.ledger_balance);
    }

    function runWagerInChildProcess(input: {
      readonly providerId: string;
      readonly idempotencyKey: string;
      readonly wager: ReturnType<typeof wagerInput>;
    }): Promise<{
      readonly pid: number;
      readonly status: string;
      readonly transactionId: string | null;
    }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL("./support/process-wager.ts", import.meta.url).pathname,
            JSON.stringify(input),
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, POSTGRES_SCHEMA: schema },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `Financial worker process exited with ${code}: ${stderr || stdout}`,
              ),
            );
            return;
          }
          try {
            resolve(
              JSON.parse(stdout.trim()) as {
                readonly pid: number;
                readonly status: string;
                readonly transactionId: string | null;
              },
            );
          } catch (error) {
            reject(
              new Error(
                `Financial worker process returned invalid output: ${String(error)}; stderr=${stderr}`,
              ),
            );
          }
        });
      });
    }

    function runSqsEventWorkerProcess(
      mode: "crash-after-commit" | "consume",
      queueName: string,
    ): Promise<{
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL("./support/process-sqs-event.ts", import.meta.url).pathname,
            mode,
            queueName,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, POSTGRES_SCHEMA: schema },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
    }

    function runSqsWagerCommandWorkerProcess(
      mode: "crash-after-wager-commit" | "consume-wager",
      queueName: string,
      deadLetterQueueName: string,
    ): Promise<{
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            new URL("./support/process-sqs-event.ts", import.meta.url).pathname,
            mode,
            queueName,
            deadLetterQueueName,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, POSTGRES_SCHEMA: schema },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      });
    }

    async function findAvailableHttpPort(): Promise<number> {
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        throw new Error("Could not allocate an HTTP API test port");
      }
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      return port;
    }

    async function waitForHttpApi(
      url: string,
      child: ReturnType<typeof spawn>,
    ): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(
            `HTTP API worker exited before ready with ${child.exitCode}`,
          );
        }
        try {
          const response = await fetch(url);
          if (response.ok) {
            return;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      throw new Error(
        "HTTP API worker did not become ready within five seconds",
      );
    }

    function runHttpApiWorkerProcess(
      port: number,
      providerCode: string,
      apiKey: string,
      postgresPort?: number,
      additionalProviderCredentials: Readonly<Record<string, string>> = {},
      additionalEnvironment: Readonly<Record<string, string>> = {},
    ): ReturnType<typeof spawn> {
      const child = spawn(
        process.execPath,
        [new URL("./support/http-api-worker.ts", import.meta.url).pathname],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: "test",
            PORT: String(port),
            POSTGRES_SCHEMA: schema,
            ...(postgresPort === undefined
              ? {}
              : { POSTGRES_PORT: String(postgresPort) }),
            PROVIDER_API_KEYS: JSON.stringify({
              ...additionalProviderCredentials,
              [providerCode]: apiKey,
            }),
            ...additionalEnvironment,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      return child;
    }

    register({
      get orm() {
        return orm;
      },
      get transactionManager() {
        return transactionManager;
      },
      get cleanupOrm() {
        return cleanupOrm;
      },
      schema,
      seedWagerContext,
      wagerInput,
      expectWalletBalanceMatchesLedger,
      fundWallet,
      runWagerInChildProcess,
      runSqsEventWorkerProcess,
      runSqsWagerCommandWorkerProcess,
      findAvailableHttpPort,
      waitForHttpApi,
      runHttpApiWorkerProcess,
    });
  });
}
