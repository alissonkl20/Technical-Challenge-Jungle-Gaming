import { describe, expect, test } from "bun:test";
import { AppModule } from "../src/app.module.js";
import { validateEnvironment } from "../src/config/env.validation.js";

describe("application setup", () => {
  test("exposes the NestJS root module", () => {
    expect(AppModule).toBeDefined();
  });

  test("validates environment variables and applies defaults", () => {
    const environment = validateEnvironment({});

    expect(environment.NODE_ENV).toBe("development");
    expect(environment.PORT).toBe(3000);
    expect(environment.OUTBOX_METRICS_PORT).toBe(9464);
    expect(environment.SQS_EVENT_METRICS_PORT).toBe(9465);
    expect(environment.PENDING_REFERENCE_METRICS_PORT).toBe(9466);
    expect(environment.POSTGRES_PORT).toBe(5432);
    expect(environment.LOCALSTACK_PORT).toBe(4566);
    expect(environment.DATABASE_TRANSACTION_MAX_RETRIES).toBe(3);
    expect(environment.PENDING_REFERENCE_TTL_HOURS).toBe(24);
    expect(environment.PENDING_REFERENCE_INITIAL_DELAY_MS).toBe(5000);
    expect(environment.OUTBOX_RETRY_BASE_DELAY_MS).toBe(1000);
    expect(environment.OUTBOX_RETRY_MAX_DELAY_MS).toBe(60000);
    expect(environment.OUTBOX_POLL_INTERVAL_MS).toBe(1000);
    expect(environment.OUTBOX_BATCH_SIZE).toBe(10);
    expect(environment.OUTBOX_LEASE_MS).toBe(30000);
    expect(environment.PENDING_REFERENCE_POLL_INTERVAL_MS).toBe(1000);
    expect(environment.PENDING_REFERENCE_BATCH_SIZE).toBe(50);
    expect(environment.SQS_OUTBOX_QUEUE_NAME).toBe("test-queue");
    expect(environment.SQS_EVENT_QUEUE_NAME).toBe("test-queue");
    expect(environment.SQS_EVENT_DLQ_NAME).toBe("financial-events-dlq");
    expect(environment.SQS_EVENT_BATCH_SIZE).toBe(10);
    expect(environment.SQS_EVENT_WAIT_TIME_SECONDS).toBe(20);
    expect(environment.SQS_EVENT_MAX_RECEIVE_COUNT).toBe(5);
    expect(environment.PROVIDER_API_KEYS).toEqual({});
  });

  test("rejects invalid ports", () => {
    expect(() => validateEnvironment({ PORT: "not-a-port" })).toThrow(
      "PORT must be a port from 1 to 65535",
    );
  });

  test("rejects invalid worker metrics ports", () => {
    expect(() => validateEnvironment({ OUTBOX_METRICS_PORT: "0" })).toThrow(
      "OUTBOX_METRICS_PORT must be a port from 1 to 65535",
    );
    expect(() =>
      validateEnvironment({ SQS_EVENT_METRICS_PORT: "not-a-port" }),
    ).toThrow("SQS_EVENT_METRICS_PORT must be a port from 1 to 65535");
    expect(() =>
      validateEnvironment({ PENDING_REFERENCE_METRICS_PORT: "65536" }),
    ).toThrow("PENDING_REFERENCE_METRICS_PORT must be a port from 1 to 65535");
  });

  test("rejects invalid transaction retry configuration", () => {
    expect(() =>
      validateEnvironment({ DATABASE_TRANSACTION_MAX_RETRIES: "11" }),
    ).toThrow(
      "DATABASE_TRANSACTION_MAX_RETRIES must be an integer from 0 to 10",
    );
  });

  test("rejects inconsistent Outbox retry delays", () => {
    expect(() =>
      validateEnvironment({
        OUTBOX_RETRY_BASE_DELAY_MS: "500",
        OUTBOX_RETRY_MAX_DELAY_MS: "100",
      }),
    ).toThrow(
      "OUTBOX_RETRY_MAX_DELAY_MS must be greater than or equal to OUTBOX_RETRY_BASE_DELAY_MS",
    );
  });

  test("rejects invalid event queue configuration", () => {
    expect(() =>
      validateEnvironment({
        SQS_EVENT_QUEUE_NAME: "not a queue",
      }),
    ).toThrow("SQS_EVENT_QUEUE_NAME must be a valid SQS queue name");
    expect(() =>
      validateEnvironment({
        SQS_EVENT_QUEUE_NAME: "same-queue",
        SQS_EVENT_DLQ_NAME: "same-queue",
      }),
    ).toThrow("SQS_EVENT_QUEUE_NAME and SQS_EVENT_DLQ_NAME must differ");
  });

  test("rejects unsupported runtime environments", () => {
    expect(() => validateEnvironment({ NODE_ENV: "staging" })).toThrow(
      "NODE_ENV must be development, test, or production",
    );
  });

  test("rejects invalid LocalStack endpoints", () => {
    expect(() =>
      validateEnvironment({ LOCALSTACK_ENDPOINT: "ftp://localhost:4566" }),
    ).toThrow("LOCALSTACK_ENDPOINT must be a valid HTTP(S) URL");
  });

  test("validates provider credentials and administrative key configuration", () => {
    const secret = "s".repeat(32);
    expect(
      validateEnvironment({
        PROVIDER_API_KEYS: JSON.stringify({ providerA: secret }),
        PROVIDER_ADMIN_API_KEY: secret,
      }).PROVIDER_API_KEYS,
    ).toEqual({ providerA: secret });
    expect(() =>
      validateEnvironment({
        PROVIDER_API_KEYS: JSON.stringify({ providerA: "weak" }),
      }),
    ).toThrow("API keys of at least 32 characters");
    expect(() =>
      validateEnvironment({ PROVIDER_ADMIN_API_KEY: "weak" }),
    ).toThrow(
      "PROVIDER_ADMIN_API_KEY must be empty or contain at least 32 characters",
    );
  });
});
