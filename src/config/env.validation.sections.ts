import { boundedInteger, requiredString } from "./env.validation.helpers.js";

type Environment = Record<string, unknown>;

export function validateRuntimeEnvironment(environment: Environment): string {
  const nodeEnvironment = requiredString(environment, "NODE_ENV");

  if (!["development", "test", "production"].includes(nodeEnvironment)) {
    throw new Error(
      "Invalid environment: NODE_ENV must be development, test, or production",
    );
  }

  return nodeEnvironment;
}

export function validateExternalServices(environment: Environment): void {
  validateLocalStackEndpoint(environment);
  validateRequiredServiceValues(environment);
  validateQueueNames(environment);
}

function validateLocalStackEndpoint(environment: Environment): void {
  const endpoint = requiredString(environment, "LOCALSTACK_ENDPOINT");

  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Invalid environment: LOCALSTACK_ENDPOINT must be a valid HTTP(S) URL",
    );
  }
}

function validateRequiredServiceValues(environment: Environment): void {
  for (const name of [
    "POSTGRES_HOST",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SQS_OUTBOX_QUEUE_NAME",
    "SQS_EVENT_QUEUE_NAME",
    "SQS_EVENT_DLQ_NAME",
    "SQS_WAGER_COMMAND_QUEUE_NAME",
    "SQS_WAGER_COMMAND_DLQ_NAME",
  ]) {
    requiredString(environment, name);
  }
}

function validateQueueNames(environment: Environment): void {
  const queueNames = [
    "SQS_OUTBOX_QUEUE_NAME",
    "SQS_EVENT_QUEUE_NAME",
    "SQS_EVENT_DLQ_NAME",
    "SQS_WAGER_COMMAND_QUEUE_NAME",
    "SQS_WAGER_COMMAND_DLQ_NAME",
  ] as const;

  for (const name of queueNames) {
    if (
      !/^[A-Za-z0-9_-]{1,80}(\.fifo)?$/.test(requiredString(environment, name))
    ) {
      throw new Error(
        `Invalid environment: ${name} must be a valid SQS queue name`,
      );
    }
  }

  if (environment.SQS_EVENT_QUEUE_NAME === environment.SQS_EVENT_DLQ_NAME) {
    throw new Error(
      "Invalid environment: SQS_EVENT_QUEUE_NAME and SQS_EVENT_DLQ_NAME must differ",
    );
  }
  if (
    environment.SQS_WAGER_COMMAND_QUEUE_NAME ===
    environment.SQS_WAGER_COMMAND_DLQ_NAME
  ) {
    throw new Error(
      "Invalid environment: SQS_WAGER_COMMAND_QUEUE_NAME and SQS_WAGER_COMMAND_DLQ_NAME must differ",
    );
  }
}

export function validatePostgresSchema(environment: Environment): string {
  const schema = requiredString(environment, "POSTGRES_SCHEMA");

  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      "Invalid environment: POSTGRES_SCHEMA must be a lowercase SQL identifier",
    );
  }

  return schema;
}

export interface OutboxSettings {
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly pollIntervalMs: number;
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}

export function validateOutboxSettings(
  environment: Environment,
): OutboxSettings {
  const retryBaseDelayMs = boundedInteger(
    environment,
    "OUTBOX_RETRY_BASE_DELAY_MS",
    0,
    3_600_000,
  );
  const retryMaxDelayMs = boundedInteger(
    environment,
    "OUTBOX_RETRY_MAX_DELAY_MS",
    0,
    86_400_000,
  );

  if (retryMaxDelayMs < retryBaseDelayMs) {
    throw new Error(
      "Invalid environment: OUTBOX_RETRY_MAX_DELAY_MS must be greater than or equal to OUTBOX_RETRY_BASE_DELAY_MS",
    );
  }

  return {
    retryBaseDelayMs,
    retryMaxDelayMs,
    pollIntervalMs: boundedInteger(
      environment,
      "OUTBOX_POLL_INTERVAL_MS",
      10,
      3_600_000,
    ),
    batchSize: boundedInteger(environment, "OUTBOX_BATCH_SIZE", 1, 1_000),
    leaseMs: boundedInteger(environment, "OUTBOX_LEASE_MS", 1, 86_400_000),
    maxAttempts: boundedInteger(environment, "OUTBOX_MAX_ATTEMPTS", 1, 1_000),
  };
}

export interface PendingReferenceWorkerSettings {
  readonly pollIntervalMs: number;
  readonly batchSize: number;
}

export function validatePendingReferenceWorkerSettings(
  environment: Environment,
): PendingReferenceWorkerSettings {
  return {
    pollIntervalMs: boundedInteger(
      environment,
      "PENDING_REFERENCE_POLL_INTERVAL_MS",
      10,
      3_600_000,
    ),
    batchSize: boundedInteger(
      environment,
      "PENDING_REFERENCE_BATCH_SIZE",
      1,
      1_000,
    ),
  };
}

export interface SqsEventSettings {
  readonly batchSize: number;
  readonly waitTimeSeconds: number;
  readonly visibilityTimeoutSeconds: number;
  readonly retryVisibilitySeconds: number;
  readonly maxReceiveCount: number;
  readonly pollIntervalMs: number;
}

export function validateSqsEventSettings(
  environment: Environment,
): SqsEventSettings {
  return {
    batchSize: boundedInteger(environment, "SQS_EVENT_BATCH_SIZE", 1, 10),
    waitTimeSeconds: boundedInteger(
      environment,
      "SQS_EVENT_WAIT_TIME_SECONDS",
      0,
      20,
    ),
    visibilityTimeoutSeconds: boundedInteger(
      environment,
      "SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS",
      1,
      43_200,
    ),
    retryVisibilitySeconds: boundedInteger(
      environment,
      "SQS_EVENT_RETRY_VISIBILITY_SECONDS",
      0,
      43_200,
    ),
    maxReceiveCount: boundedInteger(
      environment,
      "SQS_EVENT_MAX_RECEIVE_COUNT",
      1,
      100,
    ),
    pollIntervalMs: boundedInteger(
      environment,
      "SQS_EVENT_POLL_INTERVAL_MS",
      10,
      3_600_000,
    ),
  };
}
