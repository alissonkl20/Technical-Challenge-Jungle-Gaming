import { DEFAULT_ENVIRONMENT } from "./env.defaults.js";
import {
  boundedInteger,
  providerApiKeys,
  validatedPort,
  validateProviderAdminApiKey,
} from "./env.validation.helpers.js";
import type {
  OutboxSettings,
  PendingReferenceWorkerSettings,
  SqsEventSettings,
} from "./env.validation.sections.js";
import {
  validateExternalServices,
  validateOutboxSettings,
  validatePendingReferenceWorkerSettings,
  validatePostgresSchema,
  validateRuntimeEnvironment,
  validateSqsEventSettings,
} from "./env.validation.sections.js";

export type { ProviderApiKeyMap } from "./env.validation.helpers.js";

export function validateEnvironment(
  configuration: Record<string, unknown>,
): Record<string, unknown> {
  const environment: Record<string, unknown> = {
    ...DEFAULT_ENVIRONMENT,
    ...configuration,
  };

  validateProviderAdminApiKey(environment);
  const nodeEnvironment = validateRuntimeEnvironment(environment);
  validateExternalServices(environment);
  const postgresSchema = validatePostgresSchema(environment);
  const outboxSettings = validateOutboxSettings(environment);
  const pendingReferenceWorkerSettings =
    validatePendingReferenceWorkerSettings(environment);
  const sqsEventSettings = validateSqsEventSettings(environment);

  return {
    ...environment,
    PROVIDER_API_KEYS: providerApiKeys(environment),
    NODE_ENV: nodeEnvironment,
    PORT: validatedPort(environment, "PORT"),
    OUTBOX_METRICS_PORT: validatedPort(environment, "OUTBOX_METRICS_PORT"),
    SQS_EVENT_METRICS_PORT: validatedPort(
      environment,
      "SQS_EVENT_METRICS_PORT",
    ),
    PENDING_REFERENCE_METRICS_PORT: validatedPort(
      environment,
      "PENDING_REFERENCE_METRICS_PORT",
    ),
    POSTGRES_PORT: validatedPort(environment, "POSTGRES_PORT"),
    POSTGRES_SCHEMA: postgresSchema,
    LOCALSTACK_PORT: validatedPort(environment, "LOCALSTACK_PORT"),
    DATABASE_TRANSACTION_MAX_RETRIES: boundedInteger(
      environment,
      "DATABASE_TRANSACTION_MAX_RETRIES",
      0,
      10,
    ),
    PENDING_REFERENCE_TTL_HOURS: boundedInteger(
      environment,
      "PENDING_REFERENCE_TTL_HOURS",
      1,
      8_760,
    ),
    PENDING_REFERENCE_INITIAL_DELAY_MS: boundedInteger(
      environment,
      "PENDING_REFERENCE_INITIAL_DELAY_MS",
      1,
      3_600_000,
    ),
    ...outboxEnvironment(outboxSettings),
    ...pendingReferenceEnvironment(pendingReferenceWorkerSettings),
    ...sqsEventEnvironment(sqsEventSettings),
  };
}

function outboxEnvironment(settings: OutboxSettings) {
  return {
    OUTBOX_RETRY_BASE_DELAY_MS: settings.retryBaseDelayMs,
    OUTBOX_RETRY_MAX_DELAY_MS: settings.retryMaxDelayMs,
    OUTBOX_POLL_INTERVAL_MS: settings.pollIntervalMs,
    OUTBOX_BATCH_SIZE: settings.batchSize,
    OUTBOX_LEASE_MS: settings.leaseMs,
    OUTBOX_MAX_ATTEMPTS: settings.maxAttempts,
  };
}

function pendingReferenceEnvironment(settings: PendingReferenceWorkerSettings) {
  return {
    PENDING_REFERENCE_POLL_INTERVAL_MS: settings.pollIntervalMs,
    PENDING_REFERENCE_BATCH_SIZE: settings.batchSize,
  };
}

function sqsEventEnvironment(settings: SqsEventSettings) {
  return {
    SQS_EVENT_BATCH_SIZE: settings.batchSize,
    SQS_EVENT_WAIT_TIME_SECONDS: settings.waitTimeSeconds,
    SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS: settings.visibilityTimeoutSeconds,
    SQS_EVENT_RETRY_VISIBILITY_SECONDS: settings.retryVisibilitySeconds,
    SQS_EVENT_MAX_RECEIVE_COUNT: settings.maxReceiveCount,
    SQS_EVENT_POLL_INTERVAL_MS: settings.pollIntervalMs,
  };
}
