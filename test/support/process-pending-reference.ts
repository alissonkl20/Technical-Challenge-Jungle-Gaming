import "reflect-metadata";

import {
  type EntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
import { ConfigService } from "@nestjs/config";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { validateEnvironment } from "../../src/config/env.validation.js";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import { PendingReferenceRetryService } from "../../src/modules/transactions/pending-reference-retry.service.js";
import { PendingReferenceWorkerService } from "../../src/modules/transactions/pending-reference-worker.service.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";

async function main(): Promise<void> {
  const schema = process.env.POSTGRES_SCHEMA;
  if (schema === undefined || !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("POSTGRES_SCHEMA must be set to a valid test schema");
  }

  const orm = await MikroORM.init<PostgreSqlDriver, EntityManager>({
    ...mikroOrmConfig,
    schema,
  });
  try {
    const transactions = new MikroOrmTransactionManager(orm.em);
    const configuration = new ConfigService(
      validateEnvironment({
        ...process.env,
        PENDING_REFERENCE_INITIAL_DELAY_MS: "1",
      }),
    );
    const worker = new PendingReferenceWorkerService(
      transactions,
      new PendingReferenceRetryService(
        transactions,
        new WagerTransactionsService(transactions, configuration),
      ),
      configuration,
    );
    console.log(JSON.stringify(await worker.processDue(10)));
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
