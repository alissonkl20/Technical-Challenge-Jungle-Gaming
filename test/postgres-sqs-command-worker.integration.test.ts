import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../src/shared/observability/json-logger.js";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
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
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL SQS wager command workers",
  (integrationContext) => {
    describe("SQS wager command workers", () => {
      test("processes FIFO wager commands through Inbox and the shared financial use case", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const queueName = `it-wager-commands-${randomUUID().replaceAll("-", "")}.fifo`;
        const deadLetterQueueName = `it-wager-commands-dlq-${randomUUID().replaceAll("-", "")}.fifo`;
        const endpoint =
          process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
        const aws = new SQSClient({
          region: process.env.AWS_REGION ?? "sa-east-1",
          endpoint,
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
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({
            QueueName: deadLetterQueueName,
            Attributes: { FifoQueue: "true" },
          }),
        );
        if (
          queue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error("LocalStack did not return wager command queue URLs");
        }

        const externalTransactionId = `sqs-wager-${randomUUID()}`;
        const idempotencyKey = `sqs-wager-key-${randomUUID()}`;
        const logLines: string[] = [];
        const command = {
          messageId: randomUUID(),
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: context.providerId,
            externalTransactionId,
            idempotencyKey,
            playerId: context.playerId,
            walletId: context.walletId,
            roundId: `sqs-round-${randomUUID()}`,
            gameId: "test-game",
            kind: "BET",
            money: { amount: "20.00", currency: "BRL" },
          },
        };
        const duplicateCommand = JSON.stringify(command);
        try {
          for (const [body, deduplicationId] of [
            [duplicateCommand, randomUUID()],
            [duplicateCommand, randomUUID()],
            [
              JSON.stringify({ ...command, messageId: randomUUID() }),
              randomUUID(),
            ],
          ]) {
            await aws.send(
              new SendMessageCommand({
                QueueUrl: queue.QueueUrl,
                MessageBody: body,
                MessageGroupId: context.walletId,
                MessageDeduplicationId: deduplicationId,
              }),
            );
          }

          const configuration = new ConfigService(
            validateEnvironment({
              SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
              SQS_WAGER_COMMAND_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_BATCH_SIZE: "10",
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
            }),
          );
          const consumer = new SqsWagerCommandConsumer(
            configuration,
            new InboxProcessor(integrationContext.transactionManager),
            new WagerTransactionsService(integrationContext.transactionManager),
            undefined,
            new JsonLogger((line) => logLines.push(line)),
          );
          const result = await consumer.receiveBatch();
          consumer.onModuleDestroy();
          expect(result).toEqual({ received: 3, acknowledged: 3 });
          expect(
            logLines
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .find(
                (entry) =>
                  entry.event === "sqs.wager_command.processed" &&
                  entry.messageId === command.messageId,
              ),
          ).toMatchObject({
            // The producer sent no correlation ID, so a new one is generated;
            // the message ID is recorded as the cause, never as the flow ID.
            causationId: command.messageId,
            providerId: context.providerId,
            transactionId: externalTransactionId,
            walletId: context.walletId,
          });

          const persisted = await integrationContext.orm.em.execute<
            {
              balance: string;
              inbox_count: string;
              wager_count: string;
              ledger_count: string;
            }[]
          >(
            `SELECT
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance,
           (SELECT count(*)::text FROM "${integrationContext.schema}".inbox
             WHERE consumer_name = 'wager-command-consumer') AS inbox_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
             WHERE external_transaction_id = ?) AS wager_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
             WHERE wager_transaction_id IN (
               SELECT id FROM "${integrationContext.schema}".wager_transactions
               WHERE external_transaction_id = ?
             )) AS ledger_count`,
            [context.walletId, externalTransactionId, externalTransactionId],
          );
          expect(persisted[0]).toEqual({
            balance: "80.00",
            inbox_count: "2",
            wager_count: "1",
            ledger_count: "1",
          });
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.walletId,
          );
        } finally {
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("routes permanent wager command messages to the FIFO DLQ before acknowledging", async () => {
        const queueName = `it-wager-invalid-${randomUUID().replaceAll("-", "")}.fifo`;
        const deadLetterQueueName = `it-wager-invalid-dlq-${randomUUID().replaceAll("-", "")}.fifo`;
        const endpoint =
          process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
        const aws = new SQSClient({
          region: process.env.AWS_REGION ?? "sa-east-1",
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        });
        const queue = await aws.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: { FifoQueue: "true" },
          }),
        );
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({
            QueueName: deadLetterQueueName,
            Attributes: { FifoQueue: "true" },
          }),
        );
        if (
          queue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return invalid command queue URLs",
          );
        }

        const consumer = new SqsWagerCommandConsumer(
          new ConfigService(
            validateEnvironment({
              SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
              SQS_WAGER_COMMAND_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
            }),
          ),
          new InboxProcessor(integrationContext.transactionManager),
          new WagerTransactionsService(integrationContext.transactionManager),
        );
        try {
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: "not-json",
              MessageGroupId: "invalid-command-group",
              MessageDeduplicationId: randomUUID(),
            }),
          );

          expect(await consumer.receiveBatch()).toEqual({
            received: 1,
            acknowledged: 1,
          });
          const receivedDeadLetter = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: deadLetterQueue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
              MessageAttributeNames: ["All"],
            }),
          );
          expect(receivedDeadLetter.Messages).toHaveLength(1);
          expect(receivedDeadLetter.Messages?.[0]?.Body).toBe("not-json");
          expect(
            receivedDeadLetter.Messages?.[0]?.MessageAttributes
              ?.dead_letter_reason?.StringValue,
          ).toContain("not valid JSON");
        } finally {
          consumer.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("recovers a committed SQS wager command after worker death before ACK", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const queueName = `it-wager-crash-${randomUUID().replaceAll("-", "")}.fifo`;
        const deadLetterQueueName = `it-wager-crash-dlq-${randomUUID().replaceAll("-", "")}.fifo`;
        const endpoint =
          process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
        const aws = new SQSClient({
          region: process.env.AWS_REGION ?? "sa-east-1",
          endpoint,
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
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({
            QueueName: deadLetterQueueName,
            Attributes: { FifoQueue: "true" },
          }),
        );
        if (
          queue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return crash recovery queue URLs",
          );
        }

        const externalTransactionId = `sqs-crash-${randomUUID()}`;
        const command = {
          messageId: randomUUID(),
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: context.providerId,
            externalTransactionId,
            idempotencyKey: `sqs-crash-key-${randomUUID()}`,
            playerId: context.playerId,
            walletId: context.walletId,
            roundId: `sqs-crash-round-${randomUUID()}`,
            gameId: "test-game",
            kind: "BET",
            money: { amount: "20.00", currency: "BRL" },
          },
        };
        try {
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: JSON.stringify(command),
              MessageGroupId: context.walletId,
              MessageDeduplicationId: randomUUID(),
            }),
          );
          const crashedWorker =
            await integrationContext.runSqsWagerCommandWorkerProcess(
              "crash-after-wager-commit",
              queueName,
              deadLetterQueueName,
            );
          expect(crashedWorker.code).toBe(0);

          const committed = await integrationContext.orm.em.execute<
            { balance: string; inbox_count: string; ledger_count: string }[]
          >(
            `SELECT
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance,
           (SELECT count(*)::text FROM "${integrationContext.schema}".inbox
             WHERE consumer_name = 'wager-command-consumer' AND message_id = ?) AS inbox_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
             WHERE wager_transaction_id IN (
               SELECT id FROM "${integrationContext.schema}".wager_transactions
               WHERE external_transaction_id = ?
             )) AS ledger_count`,
            [context.walletId, command.messageId, externalTransactionId],
          );
          expect(committed[0]).toEqual({
            balance: "80.00",
            inbox_count: "1",
            ledger_count: "1",
          });

          await new Promise((resolve) => setTimeout(resolve, 1_100));
          const restarted =
            await integrationContext.runSqsWagerCommandWorkerProcess(
              "consume-wager",
              queueName,
              deadLetterQueueName,
            );
          expect(restarted.code).toBe(0);
          expect(JSON.parse(restarted.stdout.trim())).toEqual({
            received: 1,
            acknowledged: 1,
          });
          const finalBalance =
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            );
          expect(finalBalance?.balance).toBe("80.00");
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.walletId,
          );
        } finally {
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("deduplicates duplicate SQS deliveries processed by two independent worker processes", async () => {
        const queueName = `it-two-workers-${randomUUID().replaceAll("-", "")}`;
        const endpoint =
          process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
        const aws = new SQSClient({
          region: process.env.AWS_REGION ?? "sa-east-1",
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        });
        const queue = await aws.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: { VisibilityTimeout: "1" },
          }),
        );
        if (queue.QueueUrl === undefined) {
          aws.destroy();
          throw new Error("LocalStack did not return the two-worker queue URL");
        }

        const messageId = randomUUID();
        const body = JSON.stringify({
          event_id: messageId,
          event_type: "WagerTransactionProcessed",
          aggregate_id: randomUUID(),
          payload: { wagerTransactionId: randomUUID() },
        });
        const triggerName = `inbox_two_workers_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        let triggerCreated = false;
        try {
          await integrationContext.orm.em.execute(
            `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           PERFORM pg_sleep(1);
           RETURN NEW;
         END;
         $$`,
          );
          await integrationContext.orm.em.execute(
            `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON "${integrationContext.schema}".inbox
         FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          triggerCreated = true;

          await Promise.all([
            aws.send(
              new SendMessageCommand({
                QueueUrl: queue.QueueUrl,
                MessageBody: body,
              }),
            ),
            aws.send(
              new SendMessageCommand({
                QueueUrl: queue.QueueUrl,
                MessageBody: body,
              }),
            ),
          ]);
          const [firstWorker, secondWorker] = await Promise.all([
            integrationContext.runSqsEventWorkerProcess("consume", queueName),
            integrationContext.runSqsEventWorkerProcess("consume", queueName),
          ]);
          expect(firstWorker.code).toBe(0);
          expect(secondWorker.code).toBe(0);
          const results = [firstWorker, secondWorker].map((worker) => {
            const ansiEscapePattern = new RegExp(
              `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
              "g",
            );
            const output = worker.stdout.replace(ansiEscapePattern, "");
            const resultLine = output
              .split(/\r?\n/)
              .map((line) => line.trim())
              .reverse()
              .find((line) => line.startsWith("{") && line.endsWith("}"));
            if (resultLine === undefined) {
              throw new Error(
                `SQS worker returned no JSON result: stdout=${worker.stdout} stderr=${worker.stderr}`,
              );
            }
            return JSON.parse(resultLine) as {
              readonly received: number;
              readonly acknowledged: number;
            };
          });
          expect(results).toEqual([
            { received: 1, acknowledged: 1 },
            { received: 1, acknowledged: 1 },
          ]);

          const persisted = await integrationContext.orm.em.execute<
            {
              inbox_count: string;
              payload_hash_count: string;
            }[]
          >(
            `SELECT count(*)::text AS inbox_count,
                count(DISTINCT payload_hash)::text AS payload_hash_count
         FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [messageId],
          );
          expect(persisted[0]).toEqual({
            inbox_count: "1",
            payload_hash_count: "1",
          });
          const remaining = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
            }),
          );
          expect(remaining.Messages ?? []).toHaveLength(0);
        } finally {
          if (triggerCreated) {
            await integrationContext.orm.em.execute(
              `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".inbox`,
            );
            await integrationContext.orm.em.execute(
              `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
            );
          }
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          aws.destroy();
        }
      });

      test("redelivers and deduplicates after a worker process exits between Inbox commit and ACK", async () => {
        const queueName = `it-crash-recovery-${randomUUID().replaceAll("-", "")}`;
        const endpoint =
          process.env.LOCALSTACK_ENDPOINT ?? "http://localhost:4566";
        const aws = new SQSClient({
          region: process.env.AWS_REGION ?? "sa-east-1",
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        });
        const queue = await aws.send(
          new CreateQueueCommand({
            QueueName: queueName,
            Attributes: { VisibilityTimeout: "1" },
          }),
        );
        if (queue.QueueUrl === undefined) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return the crash recovery queue URL",
          );
        }

        try {
          const messageId = randomUUID();
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: JSON.stringify({
                event_id: messageId,
                event_type: "WagerTransactionProcessed",
                aggregate_id: randomUUID(),
                payload: { wagerTransactionId: randomUUID() },
              }),
            }),
          );

          const crashedWorker =
            await integrationContext.runSqsEventWorkerProcess(
              "crash-after-commit",
              queueName,
            );
          expect(crashedWorker.code).toBe(0);
          const committedInboxRows = await integrationContext.orm.em.execute<
            { count: string }[]
          >(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [messageId],
          );
          expect(committedInboxRows[0]?.count).toBe("1");

          let recovered = false;
          for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
            const restartedWorker =
              await integrationContext.runSqsEventWorkerProcess(
                "consume",
                queueName,
              );
            expect(restartedWorker.code).toBe(0);
            const result = JSON.parse(restartedWorker.stdout.trim()) as {
              readonly received: number;
              readonly acknowledged: number;
            };
            recovered = result.received === 1 && result.acknowledged === 1;
          }
          expect(recovered).toBe(true);

          const remaining = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          expect(remaining.Messages ?? []).toHaveLength(0);
          const finalInboxRows = await integrationContext.orm.em.execute<
            { count: string }[]
          >(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [messageId],
          );
          expect(finalInboxRows[0]?.count).toBe("1");
        } finally {
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          aws.destroy();
        }
      });
    });
  },
);
