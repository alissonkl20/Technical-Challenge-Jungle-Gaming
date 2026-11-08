import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  ConfigService,
  CreateQueueCommand,
  DeleteQueueCommand,
  InboxPayloadConflictError,
  InboxProcessor,
  type OutboxMessage,
  OutboxService,
  outboxRowFixture,
  ReceiveMessageCommand,
  randomUUID,
  SQSClient,
  SqsOutboxPublisher,
  validateEnvironment,
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL Inbox and Outbox semantics",
  (integrationContext) => {
    describe("Inbox and Outbox semantics", () => {
      test("deduplicates Inbox messages and rolls back all writes on failure", async () => {
        const message = {
          id: randomUUID(),
          consumer_name: "integration-consumer",
          message_id: randomUUID(),
          payload_hash: "b".repeat(64),
        };

        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(await session.inbox.createIfAbsent(message)).not.toBeNull();
          },
        );
        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(await session.inbox.createIfAbsent(message)).toBeNull();
          },
        );

        const rolledBackProviderId = randomUUID();
        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            await session.providers.create({
              id: rolledBackProviderId,
              code: "rolled-back-provider",
              name: "Will Roll Back",
              status: "ACTIVE",
            });
            throw new Error("force transaction rollback");
          }),
        ).rejects.toThrow("force transaction rollback");

        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(
              await session.providers.findById(rolledBackProviderId),
            ).toBeNull();
          },
        );
      });

      test("processes Inbox effects atomically, deduplicates messages, and rejects hash conflicts", async () => {
        const inbox = new InboxProcessor(integrationContext.transactionManager);
        const consumerName = `inbox-${randomUUID()}`;
        const messageId = randomUUID();
        const providerId = randomUUID();
        let handlerCalls = 0;
        const payload = {
          provider: { name: "Inbox provider", code: "inbox-provider" },
        };

        const first = await inbox.process(
          consumerName,
          messageId,
          payload,
          async (session, message) => {
            handlerCalls += 1;
            const provider = await session.providers.create({
              id: providerId,
              code: `${message.provider.code}-${randomUUID()}`,
              name: message.provider.name,
              status: "ACTIVE",
            });
            return provider.id;
          },
        );
        expect(first).toEqual({ processed: true, result: providerId });

        const duplicate = await inbox.process(
          consumerName,
          messageId,
          { provider: { code: "inbox-provider", name: "Inbox provider" } },
          async () => {
            handlerCalls += 1;
            throw new Error("Duplicate Inbox handler must not run");
          },
        );
        expect(duplicate).toEqual({ processed: false });
        expect(handlerCalls).toBe(1);

        await expect(
          inbox.process(
            consumerName,
            messageId,
            { changed: true },
            async () => {
              handlerCalls += 1;
            },
          ),
        ).rejects.toBeInstanceOf(InboxPayloadConflictError);
        expect(handlerCalls).toBe(1);

        const rollbackMessageId = randomUUID();
        const rollbackProviderId = randomUUID();
        await expect(
          inbox.process(
            consumerName,
            rollbackMessageId,
            { name: "rolled back" },
            async (session) => {
              await session.providers.create({
                id: rollbackProviderId,
                code: `inbox-rollback-${randomUUID()}`,
                name: "Rolled back",
                status: "ACTIVE",
              });
              throw new Error("inbox local effect failed");
            },
          ),
        ).rejects.toThrow("inbox local effect failed");

        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(
              await session.inbox.findByConsumerAndMessage(
                consumerName,
                rollbackMessageId,
              ),
            ).toBeNull();
            expect(
              await session.providers.findById(rollbackProviderId),
            ).toBeNull();
          },
        );

        let concurrentHandlerCalls = 0;
        const concurrentMessageId = randomUUID();
        const concurrentResults = await Promise.all([
          inbox.process(
            consumerName,
            concurrentMessageId,
            { value: "shared" },
            async (session) => {
              concurrentHandlerCalls += 1;
              await new Promise((resolve) => setTimeout(resolve, 20));
              await session.providers.create({
                id: randomUUID(),
                code: `inbox-concurrent-${randomUUID()}`,
                name: "Concurrent Inbox",
                status: "ACTIVE",
              });
            },
          ),
          inbox.process(
            consumerName,
            concurrentMessageId,
            { value: "shared" },
            async () => {
              concurrentHandlerCalls += 1;
            },
          ),
        ]);
        expect(
          concurrentResults.filter((result) => result.processed),
        ).toHaveLength(1);
        expect(concurrentHandlerCalls).toBe(1);
      });

      test("deduplicates 30 simultaneous Inbox deliveries with one committed effect", async () => {
        const inbox = new InboxProcessor(integrationContext.transactionManager);
        const consumerName = `inbox-burst-${randomUUID()}`;
        const messageId = randomUUID();
        const providerCode = `inbox-effect-${randomUUID()}`;
        const payload = {
          provider: { code: providerCode, name: "Inbox burst" },
        };
        let handlerCalls = 0;

        const results = await Promise.all(
          Array.from({ length: 30 }, () =>
            inbox.process(consumerName, messageId, payload, async (session) => {
              handlerCalls += 1;
              await new Promise((resolve) => setTimeout(resolve, 10));
              const provider = await session.providers.create({
                id: randomUUID(),
                code: providerCode,
                name: payload.provider.name,
                status: "ACTIVE",
              });
              return provider.id;
            }),
          ),
        );

        expect(results.filter((result) => result.processed)).toHaveLength(1);
        expect(results.filter((result) => !result.processed)).toHaveLength(29);
        expect(handlerCalls).toBe(1);

        const persisted = await integrationContext.orm.em.execute<
          {
            inbox_count: string;
            effect_count: string;
            payload_hash_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".inbox
          WHERE consumer_name = ? AND message_id = ?) AS inbox_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".providers
          WHERE code = ?) AS effect_count,
         (SELECT count(DISTINCT payload_hash)::text FROM "${integrationContext.schema}".inbox
          WHERE consumer_name = ? AND message_id = ?) AS payload_hash_count`,
          [consumerName, messageId, providerCode, consumerName, messageId],
        );
        expect(persisted[0]).toEqual({
          inbox_count: "1",
          effect_count: "1",
          payload_hash_count: "1",
        });
      });

      test("retries after a worker crash following SQS publish with a stable event ID and recovers leases", async () => {
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".outbox
       SET status = 'PUBLISHED', published_at = now()
       WHERE status = 'PENDING'`,
        );
        const received: OutboxMessage[] = [];
        let simulateLostConfirmation = true;
        const publisher = {
          publish: async (message: OutboxMessage): Promise<void> => {
            received.push(message);
            if (simulateLostConfirmation) {
              simulateLostConfirmation = false;
              throw new Error(
                "SQS accepted the message but confirmation was lost",
              );
            }
          },
        };
        const outbox = new OutboxService(
          integrationContext.transactionManager,
          publisher,
          0,
          0,
        );
        const wagerTransactionId = randomUUID();
        const event = await integrationContext.transactionManager.transaction(
          (session) =>
            session.outbox.create(
              outboxRowFixture({
                eventType: "WagerTransactionProcessed",
                correlationId: wagerTransactionId,
                data: { wagerTransactionId },
              }),
            ),
        );

        const first = await outbox.dispatchBatch(
          `worker-${randomUUID()}`,
          10,
          10_000,
        );
        expect(first.claimed).toBe(1);
        expect(first.published).toBe(0);
        expect(first.failures).toHaveLength(1);

        const retry = await outbox.dispatchBatch(
          `worker-${randomUUID()}`,
          10,
          10_000,
        );
        expect(retry.claimed).toBe(1);
        expect(retry.published).toBe(1);
        expect(received).toHaveLength(2);
        expect(received[0]?.eventId).toBe(event.id);
        expect(received[1]?.eventId).toBe(event.id);
        expect(received[1]?.payload).toEqual(event.payload);
        expect(received[1]?.eventId).toBe(received[0]?.eventId);

        const persisted =
          await integrationContext.transactionManager.transaction((session) =>
            session.outbox.findById(event.id),
          );
        expect(persisted?.status).toBe("PUBLISHED");
        expect(persisted?.attempts).toBe(2);
        expect(persisted?.last_error).toBeNull();
        expect(persisted?.published_at).not.toBeNull();

        const leased = await integrationContext.transactionManager.transaction(
          (session) =>
            session.outbox.create(
              outboxRowFixture({
                eventType: "WalletBalanceChanged",
                data: { walletId: randomUUID() },
              }),
            ),
        );
        const oldWorker = `worker-${randomUUID()}`;
        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(
              await session.outbox.claimDue(oldWorker, 1, 10_000),
            ).toHaveLength(1);
          },
        );
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".outbox
       SET locked_until = now() - interval '1 second'
       WHERE id = ?`,
          [leased.id],
        );

        const newWorker = `worker-${randomUUID()}`;
        const recovered =
          await integrationContext.transactionManager.transaction(
            async (session) => {
              expect(await session.outbox.recoverExpiredLeases()).toBe(1);
              return session.outbox.claimDue(newWorker, 1, 10_000);
            },
          );
        expect(recovered.map((row) => row.id)).toEqual([leased.id]);
        await integrationContext.transactionManager.transaction(
          async (session) => {
            expect(
              await session.outbox.markPublished(
                leased.id,
                oldWorker,
                new Date(),
              ),
            ).toBe(false);
          },
        );

        const concurrentEvent =
          await integrationContext.transactionManager.transaction((session) =>
            session.outbox.create(
              outboxRowFixture({
                eventType: "WagerTransactionRejected",
                data: { reason: "single-event claim concurrency test" },
              }),
            ),
          );
        const claims = await Promise.all([
          integrationContext.transactionManager.transaction((session) =>
            session.outbox.claimDue(`worker-${randomUUID()}`, 1, 10_000),
          ),
          integrationContext.transactionManager.transaction((session) =>
            session.outbox.claimDue(`worker-${randomUUID()}`, 1, 10_000),
          ),
        ]);
        const claimedIds = claims
          .flat()
          .map((row) => row.id)
          .sort();
        expect(claimedIds).toEqual([concurrentEvent.id]);
        expect(claims.reduce((total, batch) => total + batch.length, 0)).toBe(
          1,
        );
      });

      test("does not publish an Outbox event before its PostgreSQL transaction commits", async () => {
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".outbox
       SET status = 'PUBLISHED',
           locked_by = NULL,
           locked_until = NULL,
           published_at = now()
       WHERE status <> 'PUBLISHED'`,
        );
        const publishedMessages: OutboxMessage[] = [];
        const publisher = {
          publish: async (message: OutboxMessage): Promise<void> => {
            publishedMessages.push(message);
          },
        };
        const outbox = new OutboxService(
          integrationContext.transactionManager,
          publisher,
          0,
          0,
        );
        const eventId = randomUUID();
        let notifyWritten: (() => void) | undefined;
        let rejectWritten: ((error: unknown) => void) | undefined;
        let releaseCommit: (() => void) | undefined;
        const eventWritten = new Promise<void>((resolve, reject) => {
          notifyWritten = resolve;
          rejectWritten = reject;
        });
        const holdCommit = new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });

        const uncommittedWrite =
          integrationContext.transactionManager.transaction(async (session) => {
            await session.outbox.create(
              outboxRowFixture({
                eventId,
                eventType: "WagerTransactionProcessed",
                data: { wagerTransactionId: randomUUID() },
              }),
            );
            notifyWritten?.();
            await holdCommit;
          });
        void uncommittedWrite.catch((error: unknown) => rejectWritten?.(error));

        try {
          await eventWritten;
          const beforeCommit = await outbox.dispatchBatch(
            `pre-commit-worker-${randomUUID()}`,
            10,
          );
          expect(beforeCommit).toEqual({
            claimed: 0,
            published: 0,
            failures: [],
          });
          expect(publishedMessages).toEqual([]);

          releaseCommit?.();
          await uncommittedWrite;

          const afterCommit = await outbox.dispatchBatch(
            `post-commit-worker-${randomUUID()}`,
            10,
          );
          expect(afterCommit).toEqual({
            claimed: 1,
            published: 1,
            failures: [],
          });
          expect(publishedMessages).toHaveLength(1);
          expect(publishedMessages[0]?.eventId).toBe(eventId);
          expect(
            await integrationContext.transactionManager.transaction((session) =>
              session.outbox.findById(eventId),
            ),
          ).toMatchObject({ status: "PUBLISHED", attempts: 1 });
        } finally {
          releaseCommit?.();
          await uncommittedWrite;
        }
      });

      test("persists Outbox publish failures with capped backoff and does not claim them early", async () => {
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".outbox
       SET status = 'PUBLISHED',
           locked_by = NULL,
           locked_until = NULL,
           published_at = now()
       WHERE status <> 'PUBLISHED'`,
        );
        const publisher = {
          publish: async (): Promise<void> => {
            throw new Error("temporary SQS outage");
          },
        };
        const retryBaseDelayMs = 500;
        const retryMaxDelayMs = 600;
        const outbox = new OutboxService(
          integrationContext.transactionManager,
          publisher,
          retryBaseDelayMs,
          retryMaxDelayMs,
        );
        const event = await integrationContext.transactionManager.transaction(
          (session) =>
            session.outbox.create(
              outboxRowFixture({
                eventType: "WagerTransactionProcessed",
                data: { wagerTransactionId: randomUUID() },
              }),
            ),
        );

        const firstStartedAt = Date.now();
        const first = await outbox.dispatchBatch(
          `retry-worker-${randomUUID()}`,
          1,
        );
        expect(first.claimed).toBe(1);
        expect(first.published).toBe(0);
        expect(first.failures).toEqual([
          { eventId: event.id, error: "temporary SQS outage" },
        ]);
        const afterFirst =
          await integrationContext.transactionManager.transaction((session) =>
            session.outbox.findById(event.id),
          );
        expect(afterFirst?.status).toBe("PENDING");
        expect(afterFirst?.attempts).toBe(1);
        expect(afterFirst?.last_error).toBe("temporary SQS outage");
        expect(afterFirst?.locked_by).toBeNull();
        const firstDelay = Date.parse(String(afterFirst?.next_attempt_at));
        expect(Number.isFinite(firstDelay)).toBe(true);
        expect(firstDelay - firstStartedAt).toBeGreaterThanOrEqual(450);
        expect(firstDelay - firstStartedAt).toBeLessThan(1_000);
        const prematureFirstRetry = await outbox.dispatchBatch(
          `retry-worker-${randomUUID()}`,
          1,
        );
        expect(prematureFirstRetry.claimed).toBe(0);

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, firstDelay - Date.now() + 50)),
        );
        const secondStartedAt = Date.now();
        const second = await outbox.dispatchBatch(
          `retry-worker-${randomUUID()}`,
          1,
        );
        expect(second.claimed).toBe(1);
        expect(second.published).toBe(0);
        const afterSecond =
          await integrationContext.transactionManager.transaction((session) =>
            session.outbox.findById(event.id),
          );
        expect(afterSecond?.status).toBe("PENDING");
        expect(afterSecond?.attempts).toBe(2);
        expect(afterSecond?.last_error).toBe("temporary SQS outage");
        const secondDelay = Date.parse(String(afterSecond?.next_attempt_at));
        expect(Number.isFinite(secondDelay)).toBe(true);
        expect(secondDelay - secondStartedAt).toBeGreaterThanOrEqual(550);
        expect(secondDelay - secondStartedAt).toBeLessThan(1_000);
        const prematureCappedRetry = await outbox.dispatchBatch(
          `retry-worker-${randomUUID()}`,
          1,
        );
        expect(prematureCappedRetry.claimed).toBe(0);

        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, secondDelay - Date.now() + 50)),
        );
        const third = await outbox.dispatchBatch(
          `retry-worker-${randomUUID()}`,
          1,
        );
        expect(third.claimed).toBe(1);
        const afterThird =
          await integrationContext.transactionManager.transaction((session) =>
            session.outbox.findById(event.id),
          );
        expect(afterThird?.attempts).toBe(3);
        expect(afterThird?.last_error).toBe("temporary SQS outage");
        expect(afterThird?.status).toBe("PENDING");
      });

      test("recovers Outbox delivery after the real SQS queue disappears and returns", async () => {
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".outbox
       SET status = 'PUBLISHED',
           locked_by = NULL,
           locked_until = NULL,
           published_at = now()
       WHERE status <> 'PUBLISHED'`,
        );
        const queueName = `it-outbox-unavailable-${randomUUID().replaceAll("-", "")}`;
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
          new CreateQueueCommand({ QueueName: queueName }),
        );
        if (queue.QueueUrl === undefined) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return the unavailable queue URL",
          );
        }

        const publisher = new SqsOutboxPublisher(
          new ConfigService(
            validateEnvironment({
              SQS_OUTBOX_QUEUE_NAME: queueName,
              LOCALSTACK_ENDPOINT: endpoint,
              AWS_REGION: process.env.AWS_REGION ?? "sa-east-1",
              AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
              AWS_SECRET_ACCESS_KEY:
                process.env.AWS_SECRET_ACCESS_KEY ?? "test",
            }),
          ),
        );
        const retryDelayMs = 250;
        const outbox = new OutboxService(
          integrationContext.transactionManager,
          publisher,
          retryDelayMs,
          retryDelayMs,
        );
        const wagerTransactionId = randomUUID();
        const event = await integrationContext.transactionManager.transaction(
          (session) =>
            session.outbox.create(
              outboxRowFixture({
                eventType: "WagerTransactionProcessed",
                correlationId: wagerTransactionId,
                data: { wagerTransactionId },
              }),
            ),
        );

        let queueExists = true;
        try {
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          queueExists = false;
          const result = await outbox.dispatchBatch(
            `unavailable-sqs-worker-${randomUUID()}`,
            1,
          );

          expect(result.claimed).toBe(1);
          expect(result.published).toBe(0);
          expect(result.failures).toHaveLength(1);
          expect(result.failures[0]?.eventId).toBe(event.id);
          expect(result.failures[0]?.error.length).toBeGreaterThan(0);

          const persisted =
            await integrationContext.transactionManager.transaction((session) =>
              session.outbox.findById(event.id),
            );
          expect(persisted?.status).toBe("PENDING");
          expect(persisted?.attempts).toBe(1);
          expect(persisted?.last_error?.length).toBeGreaterThan(0);
          expect(persisted?.locked_by).toBeNull();
          expect(
            Date.parse(String(persisted?.next_attempt_at)) - Date.now(),
          ).toBeGreaterThan(0);

          const prematureRetry = await outbox.dispatchBatch(
            `unavailable-sqs-retry-${randomUUID()}`,
            1,
          );
          expect(prematureRetry.claimed).toBe(0);
          expect(
            await integrationContext.transactionManager.transaction((session) =>
              session.outbox.findById(event.id),
            ),
          ).toMatchObject({ status: "PENDING", attempts: 1 });

          const retryAt = Date.parse(String(persisted?.next_attempt_at));
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, retryAt - Date.now() + 50)),
          );
          const recoveredQueue = await aws.send(
            new CreateQueueCommand({ QueueName: queueName }),
          );
          if (recoveredQueue.QueueUrl === undefined) {
            throw new Error("LocalStack did not recreate the Outbox queue");
          }
          queueExists = true;

          const recovered = await outbox.dispatchBatch(
            `recovered-sqs-worker-${randomUUID()}`,
            1,
          );
          expect(recovered).toMatchObject({
            claimed: 1,
            published: 1,
            failures: [],
          });

          const received = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: recoveredQueue.QueueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
            }),
          );
          expect(received.Messages).toHaveLength(1);
          expect(
            JSON.parse(received.Messages?.[0]?.Body ?? "{}"),
          ).toMatchObject({
            eventId: event.id,
            eventType: "WagerTransactionProcessed",
            aggregateId: event.aggregate_id,
            correlationId: wagerTransactionId,
            version: 1,
            data: { wagerTransactionId },
          });
          expect(
            await integrationContext.transactionManager.transaction((session) =>
              session.outbox.findById(event.id),
            ),
          ).toMatchObject({
            status: "PUBLISHED",
            attempts: 2,
            last_error: null,
          });
        } finally {
          publisher.onModuleDestroy();
          if (queueExists) {
            await aws.send(
              new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }),
            );
          }
          aws.destroy();
        }
      });

      test("publishes FIFO Outbox events with stable group and deduplication IDs", async () => {
        const queueName = `it-outbox-${randomUUID().replaceAll("-", "")}.fifo`;
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
            Attributes: {
              FifoQueue: "true",
              ContentBasedDeduplication: "false",
            },
          }),
        );
        if (queue.QueueUrl === undefined) {
          aws.destroy();
          throw new Error(
            "LocalStack did not return the FIFO Outbox queue URL",
          );
        }

        const publisher = new SqsOutboxPublisher(
          new ConfigService(
            validateEnvironment({
              SQS_OUTBOX_QUEUE_NAME: queueName,
              LOCALSTACK_ENDPOINT: endpoint,
              AWS_REGION: process.env.AWS_REGION ?? "sa-east-1",
              AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
              AWS_SECRET_ACCESS_KEY:
                process.env.AWS_SECRET_ACCESS_KEY ?? "test",
            }),
          ),
        );

        try {
          const row = outboxRowFixture({
            eventType: "WagerTransactionProcessed",
            data: { accepted: true },
          });
          const message: OutboxMessage = {
            eventId: row.id,
            eventType: row.event_type,
            aggregateId: row.aggregate_id,
            payload: row.payload,
          };
          await publisher.publish(message);
          await publisher.publish(message);

          const received = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
              MessageSystemAttributeNames: ["MessageGroupId"],
            }),
          );
          expect(received.Messages).toHaveLength(1);
          expect(received.Messages?.[0]?.Attributes?.MessageGroupId).toBe(
            message.aggregateId,
          );
          expect(received.Messages?.[0]?.Body).toContain(message.eventId);
        } finally {
          publisher.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          aws.destroy();
        }
      });

      test("allows two independent Outbox publishers to claim and publish an event once", async () => {
        const queueName = `it-publishers-${randomUUID().replaceAll("-", "")}`;
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
          new CreateQueueCommand({ QueueName: queueName }),
        );
        if (queue.QueueUrl === undefined) {
          aws.destroy();
          throw new Error("LocalStack did not return the publisher queue URL");
        }

        const publisherConfiguration = new ConfigService(
          validateEnvironment({
            SQS_OUTBOX_QUEUE_NAME: queueName,
            LOCALSTACK_ENDPOINT: endpoint,
          }),
        );
        const firstPublisher = new SqsOutboxPublisher(publisherConfiguration);
        const secondPublisher = new SqsOutboxPublisher(publisherConfiguration);
        const firstWorker = new OutboxService(
          integrationContext.transactionManager,
          firstPublisher,
          0,
          0,
        );
        const secondWorker = new OutboxService(
          integrationContext.transactionManager,
          secondPublisher,
          0,
          0,
        );

        try {
          await integrationContext.orm.em.execute(
            `UPDATE "${integrationContext.schema}".outbox
         SET status = 'PUBLISHED',
             locked_by = NULL,
             locked_until = NULL,
             published_at = now()
         WHERE status = 'PENDING'`,
          );
          const event = await integrationContext.transactionManager.transaction(
            (session) =>
              session.outbox.create(
                outboxRowFixture({
                  eventType: "WagerTransactionProcessed",
                  data: { accepted: true },
                }),
              ),
          );
          const dispatches = await Promise.all([
            firstWorker.dispatchBatch(
              `publisher-one-${randomUUID()}`,
              1,
              10_000,
            ),
            secondWorker.dispatchBatch(
              `publisher-two-${randomUUID()}`,
              1,
              10_000,
            ),
          ]);

          expect(
            dispatches.reduce((count, result) => count + result.claimed, 0),
          ).toBe(1);
          expect(
            dispatches.reduce((count, result) => count + result.published, 0),
          ).toBe(1);
          const received = await aws.send(
            new ReceiveMessageCommand({
              QueueUrl: queue.QueueUrl,
              MaxNumberOfMessages: 10,
              WaitTimeSeconds: 1,
            }),
          );
          expect(received.Messages).toHaveLength(1);
          expect(received.Messages?.[0]?.Body).toContain(event.id);
          const persisted =
            await integrationContext.transactionManager.transaction((session) =>
              session.outbox.findById(event.id),
            );
          expect(persisted?.status).toBe("PUBLISHED");
        } finally {
          firstPublisher.onModuleDestroy();
          secondPublisher.onModuleDestroy();
          await aws.send(new DeleteQueueCommand({ QueueUrl: queue.QueueUrl }));
          aws.destroy();
        }
      });
    });
  },
);
