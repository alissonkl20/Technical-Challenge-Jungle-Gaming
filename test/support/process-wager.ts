import "reflect-metadata";

import {
  type EntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";

interface ProcessWagerRequest {
  readonly providerId: string;
  readonly idempotencyKey: string;
  readonly wager: {
    readonly externalPlayerId: string;
    readonly externalTransactionId: string;
    readonly kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
    readonly amount: string;
    readonly currency: string;
    readonly externalReferenceTransactionId?: string;
    readonly roundId?: string;
    readonly gameId?: string;
  };
}

async function main(): Promise<void> {
  const serializedRequest = process.argv[2];
  if (serializedRequest === undefined) {
    throw new Error("Missing serialized wager request");
  }
  const request = JSON.parse(serializedRequest) as ProcessWagerRequest;
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
    const result = await wagers.process(
      request.providerId,
      request.idempotencyKey,
      request.wager,
    );
    console.log(
      JSON.stringify({
        pid: process.pid,
        status: result.response.status,
        transactionId: result.response.transaction?.id ?? null,
      }),
    );
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
