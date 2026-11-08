import { hostname } from "node:os";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import {
  metricsPort,
  outboxSettings,
  shutdownTimeoutMs,
} from "../config/settings.js";
import { OutboxService } from "../modules/outbox/outbox.service.js";
import { errorStack } from "../shared/errors/error-chain.js";
import { FinancialMetrics } from "../shared/observability/financial-metrics.js";
import { JsonLogger } from "../shared/observability/json-logger.js";
import { startMetricsServer } from "../shared/observability/metrics-server.js";
import { armShutdownDeadline, sleep } from "./worker-runtime.js";

const logger = new Logger("OutboxWorker");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new JsonLogger(),
  });
  const configuration = app.get(ConfigService);
  const outbox = app.get(OutboxService);
  const metrics = app.get(FinancialMetrics);
  const structuredLogger = app.get(JsonLogger);
  const workerId = `outbox-${hostname()}-${process.pid}`;
  const { batchSize, leaseMs, pollIntervalMs } = outboxSettings(configuration);
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
      async () => {
        await outbox.refreshLagMetric();
        return metrics.renderPrometheus();
      },
      metricsPort(configuration, "outbox"),
      structuredLogger,
    );
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    logger.log(`Started with worker ID ${workerId}`);
    while (!stopping) {
      try {
        const result = await outbox.dispatchBatch(workerId, batchSize, leaseMs);
        if (result.claimed === 0) {
          await sleep(pollIntervalMs);
        }
      } catch (error) {
        logger.error("Outbox dispatch cycle failed", errorStack(error));
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
  logger.error("Outbox worker failed to start", errorStack(error));
  process.exitCode = 1;
});
