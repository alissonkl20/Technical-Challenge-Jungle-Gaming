import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../../../src/shared/observability/json-logger.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  ChangeMessageVisibilityCommand,
  ConfigService,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  FinancialMetrics,
  InboxProcessor,
  type PersistenceSession,
  ReceiveMessageCommand,
  randomUUID,
  SendMessageCommand,
  SQSClient,
  SqsEventConsumer,
  type TransactionManager,
  validateEnvironment,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL SQS event consumers and recovery",
  (integrationContext) => {
    describe("SQS event consumers and recovery", () => {
      test("consumes SQS events after Inbox commit and routes permanent events to the DLQ", async () => {
        const suffix = randomUUID().replaceAll("-", "");
        const queueName = `it-events-${suffix}`;
        const deadLetterQueueName = `it-events-dlq-${suffix}`;
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
        const eventQueue = await aws.send(
          new CreateQueueCommand({ QueueName: queueName }),
        );
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({ QueueName: deadLetterQueueName }),
        );
        if (
          eventQueue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error("LocalStack did not return the event queue URLs");
        }

        const consumerMetrics = new FinancialMetrics();
        const logLines: string[] = [];
        const consumer = new SqsEventConsumer(
          new ConfigService(
            validateEnvironment({
              SQS_EVENT_QUEUE_NAME: queueName,
              SQS_EVENT_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
            }),
          ),
          new InboxProcessor(integrationContext.transactionManager),
          consumerMetrics,
          new JsonLogger((line) => logLines.push(line)),
        );

        try {
          const eventId = randomUUID();
          const validEvent = JSON.stringify({
            eventId,
            eventType: "WagerTransactionProcessed",
            aggregateId: randomUUID(),
            correlationId: eventId,
            occurredAt: new Date().toISOString(),
            version: 1,
            data: { accepted: true },
          });
          await aws.send(
            new SendMessageCommand({
              QueueUrl: eventQueue.QueueUrl,
              MessageBody: validEvent,
            }),
          );
          expect(await consumer.receiveBatch()).toEqual({
            received: 1,
            acknowledged: 1,
          });
          expect(
            logLines
              .map((line) => JSON.parse(line) as Record<string, unknown>)
              .find((entry) => entry.event === "sqs.event.processed"),
          ).toMatchObject({
            correlationId: eventId,
            messageId: eventId,
          });

          const duplicateSends = await Promise.all([
            aws.send(
              new SendMessageCommand({
                QueueUrl: eventQueue.QueueUrl,
                MessageBody: validEvent,
              }),
            ),
            aws.send(
              new SendMessageCommand({
                QueueUrl: eventQueue.QueueUrl,
                MessageBody: validEvent,
              }),
            ),
          ]);
          expect(duplicateSends).toHaveLength(2);
          expect(await consumer.receiveBatch()).toEqual({
            received: 2,
            acknowledged: 2,
          });
          const inboxCount = await integrationContext.orm.em.execute<
            { count: string }[]
          >(
            `SELECT count(*)::text AS count FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [eventId],
          );
          expect(inboxCount[0]?.count).toBe("1");
          await integrationContext.transactionManager.transaction(
            async (session) => {
              expect(
                await session.inbox.findByConsumerAndMessage(
                  "financial-event-consumer",
                  eventId,
                ),
              ).not.toBeNull();
            },
          );

          await aws.send(
            new SendMessageCommand({
              QueueUrl: eventQueue.QueueUrl,
              MessageBody: JSON.stringify({
                event_id: randomUUID(),
                event_type: "UnknownEvent",
                aggregate_id: randomUUID(),
                payload: {},
              }),
            }),
          );
          expect(await consumer.receiveBatch()).toEqual({
            received: 1,
            acknowledged: 1,
          });
          const deadLetter = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: deadLetterQueue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          const deadLetterMessage = deadLetter.Messages?.[0];
          expect(deadLetterMessage?.Body).toContain("UnknownEvent");
          const metricOutput = consumerMetrics.renderPrometheus();
          expect(metricOutput).toContain("sqs_messages_dead_letter_total 1");
          expect(metricOutput).toContain(
            'idempotency_duplicates_total{outcome="replay"} 2',
          );
          if (deadLetterMessage?.ReceiptHandle === undefined) {
            throw new Error("Permanent SQS message was not sent to the DLQ");
          }
          await aws.send(
            new DeleteMessageCommand({
              QueueUrl: deadLetterQueue.QueueUrl,
              ReceiptHandle: deadLetterMessage.ReceiptHandle,
            }),
          );
        } finally {
          consumer.onModuleDestroy();
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: eventQueue.QueueUrl }),
          );
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("retries transient Inbox failures and acknowledges only after a successful retry", async () => {
        const queueName = `it-transient-${randomUUID().replaceAll("-", "")}`;
        const deadLetterQueueName = `it-transient-dlq-${randomUUID().replaceAll("-", "")}`;
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
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({ QueueName: deadLetterQueueName }),
        );
        if (
          queue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return the transient test queue URLs",
          );
        }

        let failFirstTransaction = true;
        const flakyTransactionManager: TransactionManager = {
          transaction<Result>(
            work: (session: PersistenceSession) => Promise<Result>,
          ): Promise<Result> {
            if (failFirstTransaction) {
              failFirstTransaction = false;
              return Promise.reject(
                new Error("temporary Inbox database failure"),
              );
            }
            return integrationContext.transactionManager.transaction(work);
          },
        };
        const metrics = new FinancialMetrics();
        const consumer = new SqsEventConsumer(
          new ConfigService(
            validateEnvironment({
              SQS_EVENT_QUEUE_NAME: queueName,
              SQS_EVENT_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
              SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "1",
              SQS_EVENT_RETRY_VISIBILITY_SECONDS: "0",
              SQS_EVENT_MAX_RECEIVE_COUNT: "3",
            }),
          ),
          new InboxProcessor(flakyTransactionManager),
          metrics,
        );

        try {
          const eventId = randomUUID();
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: JSON.stringify({
                event_id: eventId,
                event_type: "WagerTransactionProcessed",
                aggregate_id: randomUUID(),
                payload: { accepted: true },
              }),
            }),
          );

          expect(await consumer.receiveBatch()).toEqual({
            received: 1,
            acknowledged: 0,
          });

          let retryResult = { received: 0, acknowledged: 0 };
          for (
            let attempt = 0;
            attempt < 10 && retryResult.received === 0;
            attempt += 1
          ) {
            retryResult = await consumer.receiveBatch();
            if (retryResult.received === 0) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          expect(retryResult).toEqual({ received: 1, acknowledged: 1 });
          expect(metrics.renderPrometheus()).toContain(
            'financial_retries_total{component="sqs"} 1',
          );
          const inboxRows = await integrationContext.orm.em.execute<
            { count: string }[]
          >(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [eventId],
          );
          expect(inboxRows[0]?.count).toBe("1");
          const deadLetters = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: deadLetterQueue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 0,
            }),
          );
          expect(deadLetters.Messages ?? []).toHaveLength(0);
        } finally {
          consumer.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("moves a transiently failing SQS event to the DLQ at the configured receive limit", async () => {
        const suffix = randomUUID().replaceAll("-", "");
        const queueName = `it-receive-limit-${suffix}`;
        const deadLetterQueueName = `it-receive-limit-dlq-${suffix}`;
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
        const deadLetterQueue = await aws.send(
          new CreateQueueCommand({ QueueName: deadLetterQueueName }),
        );
        if (
          queue.QueueUrl === undefined ||
          deadLetterQueue.QueueUrl === undefined
        ) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return the receive-limit queue URLs",
          );
        }

        let failedAttempts = 0;
        const unavailableTransactionManager: TransactionManager = {
          transaction<Result>(
            _work: (session: PersistenceSession) => Promise<Result>,
          ): Promise<Result> {
            failedAttempts += 1;
            const error = new Error(
              "temporary PostgreSQL connection failure",
            ) as Error & {
              code: string;
            };
            error.code = "ECONNRESET";
            return Promise.reject(error);
          },
        };
        const metrics = new FinancialMetrics();
        const consumer = new SqsEventConsumer(
          new ConfigService(
            validateEnvironment({
              SQS_EVENT_QUEUE_NAME: queueName,
              SQS_EVENT_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
              SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "1",
              SQS_EVENT_RETRY_VISIBILITY_SECONDS: "0",
              SQS_EVENT_MAX_RECEIVE_COUNT: "2",
            }),
          ),
          new InboxProcessor(unavailableTransactionManager),
          metrics,
        );

        try {
          const eventId = randomUUID();
          const body = JSON.stringify({
            event_id: eventId,
            event_type: "WagerTransactionProcessed",
            aggregate_id: randomUUID(),
            payload: { accepted: true },
          });
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: body,
            }),
          );

          expect(await consumer.receiveBatch()).toEqual({
            received: 1,
            acknowledged: 0,
          });
          let secondAttempt = { received: 0, acknowledged: 0 };
          for (
            let attempt = 0;
            attempt < 10 && secondAttempt.received === 0;
            attempt += 1
          ) {
            secondAttempt = await consumer.receiveBatch();
            if (secondAttempt.received === 0) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          expect(secondAttempt).toEqual({ received: 1, acknowledged: 1 });
          expect(failedAttempts).toBe(2);
          expect(metrics.renderPrometheus()).toContain(
            "sqs_messages_dead_letter_total 1",
          );

          const deadLetter = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: deadLetterQueue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
              MessageAttributeNames: ["All"],
            }),
          );
          expect(deadLetter.Messages).toHaveLength(1);
          expect(deadLetter.Messages?.[0]?.Body).toBe(body);
          expect(
            deadLetter.Messages?.[0]?.MessageAttributes?.dead_letter_reason
              ?.StringValue,
          ).toContain("temporary PostgreSQL connection failure");

          const remaining = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 0,
            }),
          );
          expect(remaining.Messages ?? []).toHaveLength(0);
          const inboxRows = await integrationContext.orm.em.execute<
            { count: string }[]
          >(
            `SELECT count(*)::text AS count FROM "${integrationContext.schema}".inbox
         WHERE consumer_name = 'financial-event-consumer' AND message_id = ?`,
            [eventId],
          );
          expect(inboxRows[0]?.count).toBe("0");
        } finally {
          consumer.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          await aws.send(
            new DeleteQueueCommand({ QueueUrl: deadLetterQueue.QueueUrl }),
          );
          aws.destroy();
        }
      });

      test("does not acknowledge a permanent SQS event when DLQ forwarding fails", async () => {
        const suffix = randomUUID().replaceAll("-", "");
        const queueName = `it-dlq-failure-${suffix}`;
        const deadLetterQueueName = `it-missing-dlq-${suffix}`;
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
            "LocalStack did not return the DLQ failure test queue URL",
          );
        }
        const consumer = new SqsEventConsumer(
          new ConfigService(
            validateEnvironment({
              SQS_EVENT_QUEUE_NAME: queueName,
              SQS_EVENT_DLQ_NAME: deadLetterQueueName,
              SQS_EVENT_WAIT_TIME_SECONDS: "0",
              SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "1",
            }),
          ),
          new InboxProcessor(integrationContext.transactionManager),
        );
        let deadLetterQueueUrl: string | undefined;

        try {
          const invalidEvent = JSON.stringify({
            event_id: randomUUID(),
            event_type: "UnsupportedEvent",
            aggregate_id: randomUUID(),
            payload: {},
          });
          await aws.send(
            new SendMessageCommand({
              QueueUrl: queue.QueueUrl,
              MessageBody: invalidEvent,
            }),
          );

          await expect(consumer.receiveBatch()).rejects.toThrow();
          const remainingVisible = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 2,
            }),
          );
          const unacknowledged = remainingVisible.Messages?.[0];
          expect(unacknowledged?.Body).toBe(invalidEvent);
          if (unacknowledged?.ReceiptHandle === undefined) {
            throw new Error("Original event was unexpectedly acknowledged");
          }
          await aws.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queue.QueueUrl,
              ReceiptHandle: unacknowledged.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
          const createdDlq = await aws.send(
            new CreateQueueCommand({ QueueName: deadLetterQueueName }),
          );
          deadLetterQueueUrl = createdDlq.QueueUrl;
          if (deadLetterQueueUrl === undefined) {
            throw new Error("LocalStack did not return the recovered DLQ URL");
          }

          const recovered = await consumer.receiveBatch();
          expect(recovered).toEqual({ received: 1, acknowledged: 1 });
          const deadLetter = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: deadLetterQueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          expect(deadLetter.Messages?.[0]?.Body).toBe(invalidEvent);
        } finally {
          consumer.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          if (deadLetterQueueUrl !== undefined) {
            await aws.send(
              new DeleteQueueCommand({ QueueUrl: deadLetterQueueUrl }),
            );
          }
          aws.destroy();
        }
      });
    });
  },
);
