import { hostname } from "node:os";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import {
  compensationSettings,
  metricsPort,
  pendingReferenceWorkerSettings,
  shutdownTimeoutMs,
} from "../config/settings.js";
import { PendingReferenceWorkerService } from "../modules/transactions/pending-reference-worker.service.js";
import { WagerCompensationService } from "../modules/transactions/wager-compensation.service.js";
import { errorStack } from "../shared/errors/error-chain.js";
import { FinancialMetrics } from "../shared/observability/financial-metrics.js";
import { JsonLogger } from "../shared/observability/json-logger.js";
import { startMetricsServer } from "../shared/observability/metrics-server.js";
import { armShutdownDeadline, sleep } from "./worker-runtime.js";

const logger = new Logger("PendingReferenceWorker");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new JsonLogger(),
  });
  const configuration = app.get(ConfigService);
  const worker = app.get(PendingReferenceWorkerService);
  // The same worker drives post-commit compensation: both resume committed
  // financial work from persisted state through the shared wager use case.
  const compensation = app.get(WagerCompensationService);
  const compensationEnabled = compensationSettings(configuration).enabled;
  const metrics = app.get(FinancialMetrics);
  const structuredLogger = app.get(JsonLogger);
  const { batchSize, pollIntervalMs } =
    pendingReferenceWorkerSettings(configuration);
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  let stopping = false;
  const stop = (): void => {
    stopping = true;
    armShutdownDeadline(shutdownTimeoutMs(configuration), () => {
      logger.error("Shutdown deadline reached; forcing exit");
      process.exit(1);
    });
  };
  try {
    metricsServer = await startMetricsServer(
      () => metrics.renderPrometheus(),
      metricsPort(configuration, "pendingReference"),
      structuredLogger,
    );
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    logger.log(`Started on host ${hostname()}`);
    while (!stopping) {
      try {
        const result = await worker.processDue(batchSize);
        const compensated = compensationEnabled
          ? await compensation.compensateDue(batchSize)
          : { examined: 0 };
        if (result.examined === 0 && compensated.examined === 0) {
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        logger.error(
          "Pending reference processing cycle failed",
          errorStack(error),
        );
        await sleep(pollIntervalMs);
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await metricsServer?.close();
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  logger.error("Pending reference worker failed to start", errorStack(error));
  process.exitCode = 1;
});
