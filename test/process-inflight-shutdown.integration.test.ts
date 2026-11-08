import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import { randomUUID } from "./postgres-test-dependencies.js";

// Determinism without arbitrary sleeps: a row lock held by this test is the
// synchronization point. The application under test blocks on it inside its
// own transaction, so the test knows exactly when the work is in flight.

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";
const inflightTests = enabled ? describe : describe.skip;

const LOCALSTACK =
  process.env.LOCALSTACK_TEST_ENDPOINT ?? "http://127.0.0.1:4566";
const REGION = process.env.AWS_REGION ?? "sa-east-1";

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
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (await condition()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for: ${label}`);
  })();
}

function spawnWorker(entry: string, env: Record<string, string>) {
  const chunks: string[] = [];
  const proc = Bun.spawn(["bun", entry], {
    cwd: `${import.meta.dir}/..`,
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

function sqsClient() {
  return new SQSClient({
    region: REGION,
    endpoint: LOCALSTACK,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

inflightTests(
  "process killed or stopped while a financial operation is in flight",
  () => {
    registerPostgresIntegrationSuite("in-flight shutdown", (ctx) => {
      const dbConfig = {
        hostname: process.env.POSTGRES_HOST ?? "localhost",
        port: Number(process.env.POSTGRES_PORT ?? "5432"),
        username: process.env.POSTGRES_USER ?? "betting_user",
        password: process.env.POSTGRES_PASSWORD ?? "betting_password",
        database: process.env.POSTGRES_DB ?? "betting_db",
        max: 2,
      };

      /** Seeds a provider with a known code and a wallet with a balance. */
      async function seed(balance: string) {
        const c = await ctx.seedWagerContext(balance);
        const code = `inflight-${randomUUID().slice(0, 8)}`;
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".providers SET code = ? WHERE id = ?`,
          [code, c.providerId],
        );
        return { ...c, code };
      }

      /** Holds a row lock on a dedicated connection until released. */
      async function holdLock(
        sql: InstanceType<typeof Bun.SQL>,
        table: string,
        id: string,
      ) {
        const conn = await sql.reserve();
        await conn.unsafe("BEGIN");
        await conn.unsafe(
          `SELECT 1 FROM "${ctx.schema}".${table} WHERE id = $1 FOR UPDATE`,
          [id],
        );
        return {
          commit: async () => {
            await conn.unsafe("COMMIT");
            conn.release();
          },
          rollback: async () => {
            await conn.unsafe("ROLLBACK");
            conn.release();
          },
        };
      }

      async function waitForLockWaiter(
        sql: InstanceType<typeof Bun.SQL>,
        label: string,
      ) {
        await waitFor(
          async () => {
            const rows = await sql.unsafe(
              `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query ILIKE '%' || $1 || '%'`,
              [label],
            );
            return Number(rows[0]?.n ?? 0) > 0;
          },
          20_000,
          `a lock waiter on ${label}`,
        );
      }

      async function balanceAndLedger(walletId: string) {
        const rows = await ctx.orm.em.execute<
          { balance: string; ledger_sum: string; entries: number }[]
        >(
          `SELECT w.balance::text AS balance,
                COALESCE((SELECT sum(CASE WHEN entry_type='CREDIT' THEN amount ELSE -amount END)
                            FROM "${ctx.schema}".wallet_ledger_entries l WHERE l.wallet_id = w.id), 0)::text AS ledger_sum,
                (SELECT count(*) FROM "${ctx.schema}".wallet_ledger_entries l WHERE l.wallet_id = w.id)::int AS entries
           FROM "${ctx.schema}".wallets w WHERE w.id = ?`,
          [walletId],
        );
        return rows[0];
      }

      async function httpAlive(port: number): Promise<boolean> {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/live`);
          return response.status === 200;
        } catch {
          return false;
        }
      }

      async function startApi(
        shutdownTimeoutMs: number,
        code: string,
        key: string,
      ) {
        const port = await freePort();
        const worker = spawnWorker("src/main.ts", {
          PORT: String(port),
          POSTGRES_SCHEMA: ctx.schema,
          SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
          PROVIDER_API_KEYS: JSON.stringify({ [code]: key }),
        });
        await waitFor(
          async () => worker.output().includes("successfully started"),
          30_000,
          "API started",
        );
        return { ...worker, port };
      }

      test("drains the in-flight request on SIGTERM, then exits 0 with a single consistent effect", async () => {
        const c = await seed("100.00");
        const key =
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        const api = await startApi(15_000, c.code, key);
        const sql = new Bun.SQL(dbConfig);
        try {
          const lock = await holdLock(sql, "wallets", c.walletId);
          const request = fetch(
            `http://127.0.0.1:${api.port}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-provider-code": c.code,
                "x-provider-key": key,
                "idempotency-key": `drain-${randomUUID()}`,
              },
              body: JSON.stringify({
                externalTransactionId: "drain-bet-1",
                playerId: c.playerId,
                walletId: c.walletId,
                kind: "BET",
                money: { amount: "10.00", currency: "BRL" },
              }),
            },
          );
          await waitForLockWaiter(sql, "FOR UPDATE");

          api.proc.kill("SIGTERM");
          // The listening socket closes at once: new work is refused.
          await waitFor(
            async () => !(await httpAlive(api.port)),
            10_000,
            "listener closed",
          );

          // The in-flight request is still running and holds no effect yet.
          expect((await balanceAndLedger(c.walletId))?.balance).toBe("100.00");
          await lock.commit();

          const response = await request;
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            status: string;
            idempotentReplay: boolean;
          };
          expect(body.status).toBe("PROCESSED");
          expect(await api.proc.exited).toBe(0);

          const state = await balanceAndLedger(c.walletId);
          expect(state?.balance).toBe("90.00");
          expect(state?.ledger_sum).toBe("90.00");
          expect(state?.entries).toBe(2);
        } finally {
          await sql.close();
        }
      }, 120_000);

      test("past the deadline the process exits non-zero and the interrupted request leaves no partial effect", async () => {
        const c = await seed("100.00");
        const key =
          randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        const api = await startApi(1_500, c.code, key);
        const sql = new Bun.SQL(dbConfig);
        try {
          const before = await balanceAndLedger(c.walletId);
          const lock = await holdLock(sql, "wallets", c.walletId);
          const request = fetch(
            `http://127.0.0.1:${api.port}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-provider-code": c.code,
                "x-provider-key": key,
                "idempotency-key": `deadline-${randomUUID()}`,
              },
              body: JSON.stringify({
                externalTransactionId: "deadline-bet-1",
                playerId: c.playerId,
                walletId: c.walletId,
                kind: "BET",
                money: { amount: "10.00", currency: "BRL" },
              }),
            },
          ).catch((error: unknown) => error);
          await waitForLockWaiter(sql, "FOR UPDATE");

          api.proc.kill("SIGTERM");
          // The deadline forces the exit while the request is still blocked.
          expect(await api.proc.exited).toBe(1);
          expect(api.output()).toContain("Shutdown deadline reached");
          // Release the lock: the aborted request must not have left anything.
          await lock.commit();
          await request;

          const after = await balanceAndLedger(c.walletId);
          expect(after?.balance).toBe(before?.balance);
          expect(after?.entries).toBe(before?.entries);
          const txRows = await ctx.orm.em.execute<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = 'deadline-bet-1'`,
          );
          expect(txRows[0]?.n).toBe(0);
        } finally {
          await sql.close();
        }
      }, 120_000);

      test("SQS command in flight: ACK only after commit, and a restart plus redelivery is safe", async () => {
        const c = await seed("100.00");
        const client = sqsClient();
        // A dedicated FIFO queue: the Compose consumers poll the shared command
        // queue and would otherwise take this message first.
        const suffix = randomUUID().slice(0, 8);
        const queueName = `inflight-${suffix}.fifo`;
        const dlqName = `inflight-${suffix}-dlq.fifo`;
        for (const name of [queueName, dlqName]) {
          await client.send(
            new CreateQueueCommand({
              QueueName: name,
              Attributes: {
                FifoQueue: "true",
                ContentBasedDeduplication: "false",
              },
            }),
          );
        }
        const queueUrl = (
          await client.send(new GetQueueUrlCommand({ QueueName: queueName }))
        ).QueueUrl as string;
        const messageId = `msg-inflight-${randomUUID()}`;
        const message = JSON.stringify({
          messageId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          correlationId: `corr-${messageId}`,
          data: {
            providerId: c.code,
            externalTransactionId: `sqs-inflight-${messageId}`,
            idempotencyKey: `${c.code}:sqs-inflight-${messageId}`,
            playerId: c.playerId,
            walletId: c.walletId,
            kind: "BET",
            money: { amount: "7.00", currency: "BRL" },
          },
        });
        const send = () =>
          client.send(
            new SendMessageCommand({
              QueueUrl: queueUrl,
              MessageBody: message,
              MessageGroupId: c.code,
              MessageDeduplicationId: `${messageId}-${randomUUID()}`,
            }),
          );
        await send();

        const sql = new Bun.SQL(dbConfig);
        const worker = spawnWorker("src/workers/sqs-event-worker.ts", {
          POSTGRES_SCHEMA: ctx.schema,
          LOCALSTACK_ENDPOINT: LOCALSTACK,
          SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
          SQS_WAGER_COMMAND_DLQ_NAME: dlqName,
          SQS_EVENT_METRICS_PORT: String(await freePort()),
          SQS_EVENT_WAIT_TIME_SECONDS: "2",
          SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "120",
          SHUTDOWN_TIMEOUT_MS: "15000",
        });
        try {
          // Block the command inside its transaction at the wallet lock.
          const lock = await holdLock(sql, "wallets", c.walletId);
          await waitForLockWaiter(sql, "FOR UPDATE");

          // Not acknowledged yet: still in flight, not deleted.
          const attrs = await client.send(
            new GetQueueAttributesCommand({
              QueueUrl: queueUrl,
              AttributeNames: [
                "ApproximateNumberOfMessagesNotVisible",
                "ApproximateNumberOfMessages",
              ],
            }),
          );
          expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe(
            "1",
          );
          const txBefore = await ctx.orm.em.execute<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = ?`,
            [`sqs-inflight-${messageId}`],
          );
          expect(txBefore[0]?.n).toBe(0);

          worker.proc.kill("SIGTERM");
          await lock.commit();
          expect(await worker.proc.exited).toBe(0);

          const txRows = await ctx.orm.em.execute<{ status: string }[]>(
            `SELECT status FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = ?`,
            [`sqs-inflight-${messageId}`],
          );
          expect(txRows[0]?.status).toBe("PROCESSED");
          const inbox = await ctx.orm.em.execute<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${ctx.schema}".inbox WHERE consumer_name = 'wager-command-consumer' AND message_id = ?`,
            [messageId],
          );
          expect(inbox[0]?.n).toBe(1);

          // Restart, then redeliver the same logical message with a new
          // deduplication ID: the Inbox must make it a no-op.
          await waitFor(
            async () => {
              const r = await client.send(
                new GetQueueAttributesCommand({
                  QueueUrl: queueUrl,
                  AttributeNames: ["ApproximateNumberOfMessages"],
                }),
              );
              return r.Attributes?.ApproximateNumberOfMessages === "0";
            },
            20_000,
            "queue empty after ack",
          );

          await send();
          const restarted = spawnWorker("src/workers/sqs-event-worker.ts", {
            POSTGRES_SCHEMA: ctx.schema,
            LOCALSTACK_ENDPOINT: LOCALSTACK,
            SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
            SQS_WAGER_COMMAND_DLQ_NAME: dlqName,
            SQS_EVENT_METRICS_PORT: String(await freePort()),
            SQS_EVENT_WAIT_TIME_SECONDS: "2",
            SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "120",
          });
          try {
            await waitFor(
              async () => restarted.output().includes('"status":"DUPLICATE"'),
              30_000,
              "duplicate detected",
            );
          } finally {
            restarted.proc.kill("SIGTERM");
            await restarted.proc.exited;
          }
          const count = await ctx.orm.em.execute<{ n: number }[]>(
            `SELECT count(*)::int AS n FROM "${ctx.schema}".wager_transactions WHERE external_transaction_id = ?`,
            [`sqs-inflight-${messageId}`],
          );
          expect(count[0]?.n).toBe(1);
          const state = await balanceAndLedger(c.walletId);
          expect(state?.balance).toBe("93.00");
          expect(state?.ledger_sum).toBe("93.00");
        } finally {
          worker.proc.kill("SIGTERM");
          await worker.proc.exited.catch(() => undefined);
          await sql.close();
        }
      }, 180_000);
    });
  },
);
