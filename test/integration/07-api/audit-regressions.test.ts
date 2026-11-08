import { expect, test } from "bun:test";
import { SubmitWagerService } from "../../../src/modules/finance/application/submit-wager.service.js";
import { IdempotencyConflictError } from "../../../src/modules/finance/domain/index.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  ConfigService,
  CreateQueueCommand,
  DeleteQueueCommand,
  InboxProcessor,
  ReceiveMessageCommand,
  randomUUID,
  SendMessageCommand,
  SQSClient,
  SqsWagerCommandConsumer,
  validateEnvironment,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

/** Regressions for the findings of the financial audit (2026-11-07). */
registerPostgresIntegrationSuite("financial audit regressions", (ctx) => {
  const s = () => `"${ctx.schema}"`;

  test("PostgreSQL refuses a second wager transaction with the same provider external ID", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const wagers = new WagerTransactionsService(ctx.transactionManager);
    await wagers.process(
      c.providerId,
      "dup-ext-key",
      ctx.wagerInput(c.externalPlayerId, "dup-ext"),
    );

    // Bypass the application: a distinct operation row, then a wager row that
    // reuses the external ID. Only the database can refuse it.
    const insert = ctx.orm.em.execute(
      `WITH op AS (
         INSERT INTO ${s()}.financial_operations
           (provider_id, idempotency_key, external_transaction_id,
            payload_hash, response_snapshot, response_http_status)
         VALUES (?, 'forged-key', 'forged-ext', repeat('a', 64), '{}'::jsonb, 202)
         RETURNING id
       )
       INSERT INTO ${s()}.wager_transactions
         (provider_id, player_id, wallet_id, financial_operation_id,
          external_transaction_id, kind, status, amount, currency)
       SELECT ?, ?, ?, op.id, 'dup-ext', 'BET', 'PENDING', 1.00, 'BRL' FROM op`,
      [c.providerId, c.providerId, c.playerId, c.walletId],
    );
    await expect(insert).rejects.toThrow(
      /uq_wager_transactions_provider_external_id/,
    );
  });

  test("Outbox events are append-only: payload and identity are immutable, delivery state is not", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const wagers = new WagerTransactionsService(ctx.transactionManager);
    const result = await wagers.process(
      c.providerId,
      "outbox-immutable-key",
      ctx.wagerInput(c.externalPlayerId, "outbox-immutable"),
    );
    const rows = await ctx.orm.em.execute<{ id: string }[]>(
      `SELECT id FROM ${s()}.outbox WHERE aggregate_id = ? LIMIT 1`,
      [result.response.transaction?.id],
    );
    const eventId = rows[0]?.id;
    expect(eventId).toBeDefined();

    await expect(
      ctx.orm.em.execute(
        `UPDATE ${s()}.outbox SET payload = '{}'::jsonb WHERE id = ?`,
        [eventId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.orm.em.execute(
        `UPDATE ${s()}.outbox SET event_type = 'Forged' WHERE id = ?`,
        [eventId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.orm.em.execute(`DELETE FROM ${s()}.outbox WHERE id = ?`, [eventId]),
    ).rejects.toThrow(/append-only/);
    await expect(ctx.orm.em.execute(`TRUNCATE ${s()}.outbox`)).rejects.toThrow(
      /append-only/,
    );

    // Delivery bookkeeping keeps working.
    const updated = await ctx.orm.em.execute<{ id: string }[]>(
      `UPDATE ${s()}.outbox SET attempts = attempts + 1, last_error = 'x'
        WHERE id = ? RETURNING id`,
      [eventId],
    );
    expect(updated).toHaveLength(1);
  });

  test("HTTP contract: the same key with another walletId is a conflict, not a replay", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const submission = new SubmitWagerService(
      ctx.transactionManager,
      new WagerTransactionsService(ctx.transactionManager),
    );
    const command = {
      playerId: c.playerId,
      walletId: c.walletId,
      externalTransactionId: "wallet-swap",
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const first = await submission.submit(
      c.providerId,
      "wallet-swap-key",
      command,
    );
    expect(first.status).toBe("PROCESSED");

    const replay = await submission.submit(
      c.providerId,
      "wallet-swap-key",
      command,
    );
    expect(replay.idempotentReplay).toBe(true);

    await expect(
      submission.submit(c.providerId, "wallet-swap-key", {
        ...command,
        walletId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const wallet = await ctx.transactionManager.transaction((session) =>
      session.wallets.findById(c.walletId),
    );
    expect(wallet?.balance).toBe("90.00");
    await ctx.expectWalletBalanceMatchesLedger(c.walletId);
  });

  test("SQS contract: a player of another provider is a recorded business rejection, acknowledged and not dead-lettered", async () => {
    const own = await ctx.seedWagerContext("100.00");
    const other = await ctx.seedWagerContext("100.00");
    const suffix = randomUUID().replaceAll("-", "");
    const queueName = `it-audit-cmd-${suffix}.fifo`;
    const dlqName = `it-audit-cmd-dlq-${suffix}.fifo`;
    const aws = new SQSClient({
      region: process.env.AWS_REGION ?? "sa-east-1",
      endpoint: process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
    const queue = await aws.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: "true", VisibilityTimeout: "1" },
      }),
    );
    const dlq = await aws.send(
      new CreateQueueCommand({
        QueueName: dlqName,
        Attributes: { FifoQueue: "true" },
      }),
    );
    try {
      const externalTransactionId = `cross-provider-${randomUUID()}`;
      await aws.send(
        new SendMessageCommand({
          QueueUrl: queue.QueueUrl,
          MessageGroupId: own.walletId,
          MessageDeduplicationId: randomUUID(),
          MessageBody: JSON.stringify({
            messageId: randomUUID(),
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: {
              providerId: own.providerId,
              externalTransactionId,
              idempotencyKey: `${own.providerId}:${externalTransactionId}`,
              // Player and wallet of ANOTHER provider.
              playerId: other.playerId,
              walletId: other.walletId,
              roundId: "round-1",
              gameId: "game-1",
              kind: "BET",
              money: { amount: "10.00", currency: "BRL" },
            },
          }),
        }),
      );
      const consumer = new SqsWagerCommandConsumer(
        new ConfigService(
          validateEnvironment({
            SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
            SQS_WAGER_COMMAND_DLQ_NAME: dlqName,
            SQS_EVENT_BATCH_SIZE: "10",
            SQS_EVENT_WAIT_TIME_SECONDS: "0",
          }),
        ),
        new InboxProcessor(ctx.transactionManager),
        new WagerTransactionsService(ctx.transactionManager),
      );
      try {
        expect(await consumer.receiveBatch()).toEqual({
          received: 1,
          acknowledged: 1,
        });
      } finally {
        consumer.onModuleDestroy();
      }

      const dead = await aws.send(
        new ReceiveMessageCommand({
          QueueUrl: dlq.QueueUrl,
          WaitTimeSeconds: 0,
        }),
      );
      expect(dead.Messages ?? []).toHaveLength(0);

      const operations = await ctx.orm.em.execute<
        { status: string; failure_code: string; provider_id: string }[]
      >(
        `SELECT response_snapshot->>'status' AS status,
                response_snapshot->>'failureCode' AS failure_code,
                provider_id
           FROM ${s()}.financial_operations
          WHERE external_transaction_id = ?`,
        [externalTransactionId],
      );
      expect(operations).toEqual([
        {
          status: "REJECTED",
          failure_code: "PLAYER_NOT_FOUND",
          provider_id: own.providerId,
        },
      ]);
      const rejectedEvents = await ctx.orm.em.execute<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${s()}.outbox
          WHERE event_type = 'WagerTransactionRejected'
            AND payload->'data'->>'externalTransactionId' = ?`,
        [externalTransactionId],
      );
      expect(rejectedEvents[0]?.count).toBe("1");
      for (const walletId of [own.walletId, other.walletId]) {
        const wallet = await ctx.transactionManager.transaction((session) =>
          session.wallets.findById(walletId),
        );
        expect(wallet?.balance).toBe("100.00");
      }
    } finally {
      await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
      await aws.send(new DeleteQueueCommand({ QueueUrl: dlq.QueueUrl }));
      aws.destroy();
    }
  }, 30_000);
});
