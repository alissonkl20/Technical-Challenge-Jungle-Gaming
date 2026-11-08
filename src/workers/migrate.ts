import { MikroORM } from "@mikro-orm/postgresql";
import { Logger } from "@nestjs/common";
import mikroOrmConfig from "../../mikro-orm.config.js";
import { errorStack } from "../shared/errors/error-chain.js";

/**
 * Applies pending migrations and exits. Docker Compose runs it before the API
 * and the workers, which start only after it completes successfully.
 *
 * It runs from the compiled image, which has no TypeScript sources, so the
 * migrations are always read from the compiled `path`.
 */
const logger = new Logger("Migrate");

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...mikroOrmConfig, preferTs: false });
  try {
    const applied = await orm.migrator.up();
    logger.log(
      applied.length === 0
        ? "Database schema is up to date"
        : `Applied ${applied.length} migration(s): ${applied
            .map((migration) => migration.name)
            .join(", ")}`,
    );
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  logger.error("Migration failed", errorStack(error));
  process.exitCode = 1;
});
