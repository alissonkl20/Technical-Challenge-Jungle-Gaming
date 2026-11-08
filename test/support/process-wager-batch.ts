import "reflect-metadata";

import {
  type EntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import type { ProcessWagerInput } from "../../src/modules/transactions/types/index.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";

/**
 * One independent application instance: its own process, ORM, connection pool
 * and service. It submits every request it is given at the same time, after a
 * shared start instant, so the instances genuinely overlap.
 */
interface BatchRequest {
  readonly providerId: string;
  readonly startAt: number;
  readonly requests: readonly {
    readonly idempotencyKey: string;
    readonly wager: ProcessWagerInput;
  }[];
}

async function main(): Promise<void> {
  const serialized = process.argv[2];
  if (serialized === undefined) {
    throw new Error("Missing serialized batch request");
  }
  const batch = JSON.parse(serialized) as BatchRequest;
  const schema = process.env.POSTGRES_SCHEMA;
  if (schema === undefined || !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("POSTGRES_SCHEMA must be set to a valid test schema");
  }

  const orm = await MikroORM.init<PostgreSqlDriver, EntityManager>({
    ...mikroOrmConfig,
    schema,
  });
  try {
    const wagers = new WagerTransactionsService(
      new MikroOrmTransactionManager(orm.em),
    );
    // Warm the pool so connection setup does not serialize the first requests.
    await orm.em.execute("SELECT 1");
    const wait = batch.startAt - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const results = await Promise.all(
      batch.requests.map(async (request) => {
        try {
          const result = await wagers.process(
            batch.providerId,
            request.idempotencyKey,
            request.wager,
          );
          return {
            status: result.response.status,
            transactionId: result.response.transaction?.id ?? null,
            failureCode: result.response.failureCode,
            idempotentReplay: result.idempotentReplay,
            error: null,
          };
        } catch (error) {
          return {
            status: null,
            transactionId: null,
            failureCode: null,
            idempotentReplay: false,
            error: error instanceof Error ? error.name : String(error),
          };
        }
      }),
    );
    console.log(JSON.stringify({ pid: process.pid, results }));
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
