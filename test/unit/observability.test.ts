import { describe, expect, test } from "bun:test";
import {
  HealthController,
  MetricsController,
} from "../../src/modules/http-api/http-api.controller.js";
import { FinancialMetrics } from "../../src/shared/observability/financial-metrics.js";
import { JsonLogger } from "../../src/shared/observability/json-logger.js";
import { startMetricsServer } from "../../src/shared/observability/metrics-server.js";
import { withCorrelationId } from "../../src/shared/observability/request-context.js";

describe("financial observability", () => {
  test("renders required metrics with bounded labels and units", () => {
    const metrics = new FinancialMetrics();
    metrics.recordTransactionStatus("PROCESSED");
    metrics.recordDuplicate("replay");
    metrics.recordRetry("database");
    metrics.recordDeadLetter();
    metrics.recordLockConflict();
    metrics.recordReconciliation(false);
    metrics.setOutboxLagMilliseconds(2_500);
    metrics.observeProcessingDuration(125);

    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain(
      'wager_transactions_total{status="PROCESSED"} 1',
    );
    expect(rendered).toContain(
      'idempotency_duplicates_total{outcome="replay"} 1',
    );
    expect(rendered).toContain(
      'financial_retries_total{component="database"} 1',
    );
    expect(rendered).toContain("sqs_messages_dead_letter_total 1");
    expect(rendered).toContain("financial_lock_conflicts_total 1");
    expect(rendered).toContain(
      'wallet_reconciliations_total{result="inconsistent"} 1',
    );
    expect(rendered).toContain("outbox_oldest_unpublished_age_seconds 2.5");
    expect(rendered).toContain("financial_processing_duration_seconds_count 1");
    expect(rendered).not.toContain("transactionId");
    expect(rendered).not.toContain("walletId");
    expect(rendered).not.toContain("providerId");
  });

  test("emits JSON logs with correlation and safe financial identifiers", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));

    withCorrelationId("request-42", () => {
      logger.emit("log", "financial.wager.processed", {
        messageId: "message-7",
        transactionId: "transaction-9",
        walletId: "wallet-3",
        providerId: "provider-2",
        status: "PROCESSED",
      });
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      event: "financial.wager.processed",
      correlationId: "request-42",
      messageId: "message-7",
      transactionId: "transaction-9",
      walletId: "wallet-3",
      providerId: "provider-2",
      status: "PROCESSED",
    });
    expect(lines[0]).not.toContain("amount");
    expect(lines[0]).not.toContain("apiKey");
  });

  test("replaces invalid external correlation identifiers", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));
    withCorrelationId("invalid\nforged", () => logger.log("request.started"));

    const log = JSON.parse(lines[0] ?? "") as { correlationId: string };
    expect(log.correlationId).not.toBe("invalid\nforged");
    expect(log.correlationId.length).toBeGreaterThan(0);
  });

  test("does not serialize arbitrary logger arguments such as exception stacks", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));
    logger.error("request.failed", "sensitive SQL parameter stack");

    expect(lines[0]).not.toContain("sensitive SQL parameter stack");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "request.failed",
      context: null,
    });
    // Outside a flow there is no correlation: the line says so instead of
    // carrying a random ID that cannot be joined to anything.
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      correlationId: null,
      causationId: null,
    });
  });

  test("carries correlation and causation from the flow that logs", () => {
    const lines: string[] = [];
    const logger = new JsonLogger((line) => lines.push(line));
    withCorrelationId("flow-1", () => logger.log("step.done"), "message-9");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      correlationId: "flow-1",
      causationId: "message-9",
    });
  });

  test("refreshes Outbox lag before exposing Prometheus metrics", async () => {
    const metrics = new FinancialMetrics();
    let refreshed = false;
    const controller = new MetricsController(metrics, {
      refreshLagMetric: async () => {
        refreshed = true;
        metrics.setOutboxLagMilliseconds(900);
      },
    });

    const rendered = await controller.scrape();
    expect(refreshed).toBe(true);
    expect(rendered).toContain("outbox_oldest_unpublished_age_seconds 0.9");
    expect(rendered).toContain(
      "# TYPE financial_processing_duration_seconds histogram",
    );
  });

  test("serves Prometheus metrics over HTTP and closes cleanly", async () => {
    const metrics = new FinancialMetrics();
    metrics.recordDeadLetter();
    const server = await startMetricsServer(
      () => metrics.renderPrometheus(),
      0,
    );

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/plain; version=0.0.4",
      );
      expect(await response.text()).toContain(
        "sqs_messages_dead_letter_total 1",
      );
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(
        404,
      );
    } finally {
      await server.close();
    }
  });

  test("reports metric scrape failures without exposing errors or losing correlation", async () => {
    const logLines: string[] = [];
    const server = await startMetricsServer(
      async () => {
        throw new Error("sensitive database detail");
      },
      0,
      new JsonLogger((line) => logLines.push(line)),
    );

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/metrics`, {
        headers: { "X-Correlation-Id": "scrape-request-17" },
      });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("sensitive database detail");
      expect(JSON.parse(logLines[0] ?? "")).toMatchObject({
        event: "metrics.scrape.failed",
        correlationId: "scrape-request-17",
        errorCode: "Error",
      });
    } finally {
      await server.close();
    }
  });

  test("keeps liveness independent from readiness dependencies", async () => {
    let readinessChecks = 0;
    const healthy = new HealthController(
      {
        checkDatabase: async () => {
          readinessChecks += 1;
        },
      },
      {
        checkReady: async () => {
          readinessChecks += 1;
        },
      },
    );
    expect(healthy.live()).toEqual({ status: "ok" });
    expect(readinessChecks).toBe(0);
    expect(await healthy.ready()).toEqual({
      status: "ok",
      dependencies: { postgres: "ok", sqs: "ok" },
    });
    expect(readinessChecks).toBe(2);

    const unavailable = new HealthController(
      {
        checkDatabase: async () => {
          throw new Error("database unavailable");
        },
      },
      {
        checkReady: async () => {
          throw new Error("SQS unavailable");
        },
      },
    );
    await expect(unavailable.ready()).rejects.toThrow("database unavailable");
    const unavailableSqs = new HealthController(
      {
        checkDatabase: async () => undefined,
      },
      {
        checkReady: async () => {
          throw new Error("SQS unavailable");
        },
      },
    );
    await expect(unavailableSqs.ready()).rejects.toThrow("SQS unavailable");
  });
});
