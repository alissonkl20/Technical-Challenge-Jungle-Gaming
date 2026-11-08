import "reflect-metadata";
import "dotenv/config";

import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module.js";
import { httpPort, shutdownTimeoutMs } from "./config/settings.js";
import { JsonLogger } from "./shared/observability/json-logger.js";
import {
  currentCorrelationId,
  withCorrelationId,
} from "./shared/observability/request-context.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const logger = app.get(JsonLogger);
  const configuration = app.get(ConfigService);
  app.useLogger(logger);
  app.use((request: Request, response: Response, next: NextFunction) => {
    const header = request.headers["x-correlation-id"];
    const suppliedId = Array.isArray(header) ? undefined : header;
    withCorrelationId(suppliedId, () => {
      const correlationId = currentCorrelationId();
      if (correlationId !== null) {
        response.setHeader("X-Correlation-Id", correlationId);
      }
      next();
    });
  });
  const port = httpPort(configuration);

  await app.listen(port);

  // Graceful stop: the server stops accepting connections and lets in-flight
  // requests finish. Each request is one database transaction, so a request
  // cut short is rolled back, and its client may safely retry with the same
  // Idempotency-Key. The deadline keeps a stuck connection from hanging the
  // process.
  const deadlineMs = shutdownTimeoutMs(configuration);
  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.log(`Received ${signal}; draining in-flight requests`);
    const deadline = setTimeout(() => {
      logger.error("Shutdown deadline reached; forcing exit");
      process.exit(1);
    }, deadlineMs);
    deadline.unref();
    app
      .close()
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch(() => {
        clearTimeout(deadline);
        process.exit(1);
      });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

void bootstrap();
