import { hostname } from "node:os";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module.js";
import {
  metricsPort,
  shutdownTimeoutMs,
  sqsEventSettings,
} from "../config/settings.js";
import { SqsEventConsumer } from "../modules/events/sqs-event-consumer.service.js";
import { SqsWagerCommandConsumer } from "../modules/events/sqs-wager-command-consumer.service.js";
import { errorStack } from "../shared/errors/error-chain.js";
import { FinancialMetrics } from "../shared/observability/financial-metrics.js";
import { JsonLogger } from "../shared/observability/json-logger.js";
import { startMetricsServer } from "../shared/observability/metrics-server.js";
import { armShutdownDeadline, sleep } from "./worker-runtime.js";

const logger = new Logger("SqsEventWorker");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: new JsonLogger(),
  });
  const configuration = app.get(ConfigService);
  const consumer = app.get(SqsEventConsumer);
  const commandConsumer = app.get(SqsWagerCommandConsumer);
  const metrics = app.get(FinancialMetrics);
  const structuredLogger = app.get(JsonLogger);
  const { pollIntervalMs } = sqsEventSettings(configuration);
  let stopping = false;
  // Aborting the long poll lets a stop take effect at once. An aborted receive
  // returns no messages, so nothing is lost. Messages already received are
  // processed and acknowledged before the batch returns.
  const abort = new AbortController();
  let activePoll: Promise<PromiseSettledResult<unknown>[]> | null = null;
  let metricsServer: Awaited<ReturnType<typeof startMetricsServer>> | undefined;
  const stop = (): void => {
    stopping = true;
    armShutdownDeadline(shutdownTimeoutMs(configuration), () => {
      logger.error("Shutdown deadline reached; forcing exit");
      process.exit(1);
    });
    abort.abort();
  };
  try {
    metricsServer = await startMetricsServer(
      () => metrics.renderPrometheus(),
      metricsPort(configuration, "sqsEvent"),
      structuredLogger,
    );
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    logger.log(`Started on host ${hostname()}`);
    while (!stopping) {
      try {
        activePoll = Promise.allSettled([
          consumer.receiveBatch(abort.signal),
          commandConsumer.receiveBatch(abort.signal),
        ]);
        const results = await activePoll;
        const failed = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failed !== undefined) throw failed.reason;
      } catch (error) {
        if (!stopping) {
          logger.error("SQS event polling failed", errorStack(error));
        }
        if (!stopping) {
          await sleep(pollIntervalMs);
        }
      } finally {
        activePoll = null;
      }
    }
  } finally {
    if (activePoll !== null) {
      await activePoll;
    }
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await metricsServer?.close();
    await app.close();
  }
}

void bootstrap().catch((error: unknown) => {
  logger.error("SQS event worker failed to start", errorStack(error));
  process.exitCode = 1;
});
