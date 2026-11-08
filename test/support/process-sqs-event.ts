import "reflect-metadata";

import {
  type EntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
import { ConfigService } from "@nestjs/config";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { validateEnvironment } from "../../src/config/env.validation.js";
import { SqsEventConsumer } from "../../src/modules/events/sqs-event-consumer.service.js";
import { SqsWagerCommandConsumer } from "../../src/modules/events/sqs-wager-command-consumer.service.js";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import type { PersistenceSession } from "../../src/modules/finance/persistence/repositories.js";
import { InboxProcessor } from "../../src/modules/inbox/inbox.processor.js";
import type { InboxProcessingResult } from "../../src/modules/inbox/types/index.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";

class ExitAfterInboxCommit extends InboxProcessor {
  override async process<Result, Payload>(
    consumerName: string,
    messageId: string,
    payload: Payload,
    handler: (session: PersistenceSession, payload: Payload) => Promise<Result>,
  ): Promise<InboxProcessingResult<Result>> {
    const result = await super.process(
      consumerName,
      messageId,
      payload,
      handler,
    );
    process.exit(0);
    return result;
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const queueName = process.argv[3];
  const schema = process.env.POSTGRES_SCHEMA;
  if (
    ![
      "crash-after-commit",
      "consume",
      "crash-after-wager-commit",
      "consume-wager",
    ].includes(mode ?? "") ||
    queueName === undefined ||
    schema === undefined ||
    !/^[a-z_][a-z0-9_]*$/.test(schema)
  ) {
    throw new Error("Invalid SQS process worker arguments");
  }

  const orm = await MikroORM.init<PostgreSqlDriver, EntityManager>({
    ...mikroOrmConfig,
    schema,
  });
  const transactions = new MikroOrmTransactionManager(orm.em);
  const inbox =
    mode === "crash-after-commit" || mode === "crash-after-wager-commit"
      ? new ExitAfterInboxCommit(transactions)
      : new InboxProcessor(transactions);
  const configuration = new ConfigService(
    validateEnvironment({
      ...process.env,
      SQS_EVENT_QUEUE_NAME: queueName,
      SQS_WAGER_COMMAND_QUEUE_NAME: queueName,
      SQS_WAGER_COMMAND_DLQ_NAME:
        process.argv[4] ?? "wager-transactions-dlq.fifo",
      SQS_EVENT_BATCH_SIZE: "1",
      SQS_EVENT_WAIT_TIME_SECONDS: "5",
      SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: "1",
      SQS_EVENT_RETRY_VISIBILITY_SECONDS: "0",
    }),
  );
  const consumer =
    mode === "consume-wager" || mode === "crash-after-wager-commit"
      ? new SqsWagerCommandConsumer(
          configuration,
          inbox,
          new WagerTransactionsService(transactions),
        )
      : new SqsEventConsumer(configuration, inbox);
  const result = await consumer.receiveBatch();
  console.log(JSON.stringify(result));
  consumer.onModuleDestroy();
  await orm.close(true);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
