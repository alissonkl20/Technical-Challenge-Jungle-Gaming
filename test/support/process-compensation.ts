import "reflect-metadata";

import {
  type EntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import { WagerCompensationService } from "../../src/modules/transactions/wager-compensation.service.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";

/**
 * One independent recovery-worker instance: it boots, waits for the shared
 * start instant, then runs one compensation pass, as a restarted or scaled
 * worker would.
 */
async function main(): Promise<void> {
  const startAt = Number(process.argv[2] ?? "0");
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
    const compensation = new WagerCompensationService(
      transactions,
      new WagerTransactionsService(transactions),
    );
    await orm.em.execute("SELECT 1");
    const wait = startAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const result = await compensation.compensateDue(50);
    console.log(JSON.stringify({ pid: process.pid, ...result }));
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
