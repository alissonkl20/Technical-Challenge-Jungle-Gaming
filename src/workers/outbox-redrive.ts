import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import { OutboxService } from "../modules/outbox/outbox.service.js";
import { errorStack } from "../shared/errors/error-chain.js";
import { JsonLogger } from "../shared/observability/json-logger.js";

/**
 * Operator command: `bun run outbox:redrive [limit]`.
 *
 * Moves FAILED outbox events back to PENDING so the publisher retries them.
 * It touches no other state and is safe to run while publishers are active,
 * because the claim query skips PENDING rows that another publisher holds.
 */
const logger = new Logger("OutboxRedrive");

async function main(): Promise<void> {
  const limit = process.argv[2] === undefined ? 100 : Number(process.argv[2]);
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new JsonLogger(),
  });
  try {
    const outbox = app.get(OutboxService);
    const redriven = await outbox.redriveFailed(limit);
    logger.log(`Redriven ${redriven} FAILED outbox event(s)`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  logger.error("Outbox redrive failed", errorStack(error));
  process.exitCode = 1;
});
