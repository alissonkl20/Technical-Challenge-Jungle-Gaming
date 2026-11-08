import type { Server } from "node:http";
import { createServer } from "node:http";
import type { JsonLogger } from "./json-logger.js";
import { withCorrelationId } from "./request-context.js";

export interface MetricsServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startMetricsServer(
  renderMetrics: () => string | Promise<string>,
  port: number,
  logger?: JsonLogger,
): Promise<MetricsServer> {
  const server = createServer((request, response) => {
    const suppliedId = request.headers["x-correlation-id"];
    const correlationId = Array.isArray(suppliedId) ? undefined : suppliedId;
    withCorrelationId(correlationId, () => {
      void serveRequest().catch((error: unknown) => {
        logger?.emit("error", "metrics.request.failed", {
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
        if (!response.headersSent) {
          response.writeHead(500).end("Metrics request failed\n");
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    });

    async function serveRequest(): Promise<void> {
      if (request.method !== "GET" || request.url !== "/metrics") {
        response.writeHead(404).end();
        return;
      }

      try {
        const metrics = await renderMetrics();
        response
          .writeHead(200, {
            "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          })
          .end(metrics);
      } catch (error) {
        logger?.emit("error", "metrics.scrape.failed", {
          errorCode: error instanceof Error ? error.name : "UNKNOWN_ERROR",
        });
        response.writeHead(503).end("Metrics temporarily unavailable\n");
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "0.0.0.0");
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Metrics server did not bind to a TCP port");
  }

  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}
