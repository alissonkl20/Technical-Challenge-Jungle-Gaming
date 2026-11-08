import type { ConfigService } from "@nestjs/config";
import type { ProviderApiKeyMap } from "./env.validation.helpers.js";
import type {
  OutboxSettings,
  PendingReferenceWorkerSettings,
  SqsEventSettings,
} from "./env.validation.sections.js";

/**
 * Typed configuration by area. Every runtime read of the environment goes
 * through these readers, so each key has one name, one type and one default.
 *
 * Keys validated by `validateEnvironment` are read with `getOrThrow`. The few
 * optional keys keep their lenient parsing: an invalid value falls back to
 * the default instead of stopping the process.
 */
export type ConfigReader = Pick<ConfigService, "get" | "getOrThrow">;

export type {
  OutboxSettings,
  PendingReferenceWorkerSettings,
  SqsEventSettings,
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_TRANSACTION_MAX_RETRIES = 3;
const DEFAULT_PENDING_REFERENCE_INITIAL_DELAY_MS = 5_000;
const DEFAULT_PENDING_REFERENCE_TTL_HOURS = 24;
const DEFAULT_OUTBOX_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_COMPENSATION_MAX_ATTEMPTS = 6;
const DEFAULT_COMPENSATION_RETRY_BASE_DELAY_MS = 5_000;

export interface PendingReferenceSettings {
  readonly initialDelayMs: number;
  readonly ttlHours: number;
}

export interface CompensationSettings {
  readonly enabled: boolean;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
}

export interface OutboxPublisherSettings {
  readonly queueName: string;
  /** A hung send counts as a failed attempt instead of stalling the lease. */
  readonly publishTimeoutMs: number;
}

export interface SqsQueueNames {
  readonly outbox: string;
  readonly event: string;
  readonly eventDeadLetter: string;
  readonly wagerCommand: string;
  readonly wagerCommandDeadLetter: string;
}

export interface AwsConnectionSettings {
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function httpPort(configuration: ConfigReader): number {
  return configuration.getOrThrow<number>("PORT");
}

const METRICS_PORT_KEYS = {
  outbox: "OUTBOX_METRICS_PORT",
  sqsEvent: "SQS_EVENT_METRICS_PORT",
  pendingReference: "PENDING_REFERENCE_METRICS_PORT",
} as const;

export function metricsPort(
  configuration: ConfigReader,
  worker: keyof typeof METRICS_PORT_KEYS,
): number {
  return configuration.getOrThrow<number>(METRICS_PORT_KEYS[worker]);
}

export function shutdownTimeoutMs(configuration: ConfigReader): number {
  return configuration.get<number>(
    "SHUTDOWN_TIMEOUT_MS",
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
}

export function databaseTransactionMaxRetries(
  configuration: ConfigReader,
): number {
  return configuration.get<number>(
    "DATABASE_TRANSACTION_MAX_RETRIES",
    DEFAULT_DATABASE_TRANSACTION_MAX_RETRIES,
  );
}

export function configuredProviderApiKeys(
  configuration: ConfigReader,
): ProviderApiKeyMap {
  return configuration.getOrThrow<ProviderApiKeyMap>("PROVIDER_API_KEYS");
}

export function providerAdminApiKey(configuration: ConfigReader): string {
  return configuration.get<string>("PROVIDER_ADMIN_API_KEY", "");
}

export function pendingReferenceSettings(
  configuration?: ConfigReader,
): PendingReferenceSettings {
  return {
    initialDelayMs:
      configuration?.get<number>(
        "PENDING_REFERENCE_INITIAL_DELAY_MS",
        DEFAULT_PENDING_REFERENCE_INITIAL_DELAY_MS,
      ) ?? DEFAULT_PENDING_REFERENCE_INITIAL_DELAY_MS,
    ttlHours:
      configuration?.get<number>(
        "PENDING_REFERENCE_TTL_HOURS",
        DEFAULT_PENDING_REFERENCE_TTL_HOURS,
      ) ?? DEFAULT_PENDING_REFERENCE_TTL_HOURS,
  };
}

export function pendingReferenceWorkerSettings(
  configuration: ConfigReader,
): PendingReferenceWorkerSettings {
  return {
    batchSize: configuration.getOrThrow<number>("PENDING_REFERENCE_BATCH_SIZE"),
    pollIntervalMs: configuration.getOrThrow<number>(
      "PENDING_REFERENCE_POLL_INTERVAL_MS",
    ),
  };
}

export function compensationSettings(
  configuration?: ConfigReader,
): CompensationSettings {
  return {
    enabled: isCompensationEnabled(configuration?.get("COMPENSATION_ENABLED")),
    maxAttempts: positiveInteger(
      configuration?.get("COMPENSATION_MAX_ATTEMPTS"),
      DEFAULT_COMPENSATION_MAX_ATTEMPTS,
    ),
    retryBaseDelayMs: positiveInteger(
      configuration?.get("COMPENSATION_RETRY_BASE_DELAY_MS"),
      DEFAULT_COMPENSATION_RETRY_BASE_DELAY_MS,
    ),
  };
}

/**
 * Off unless explicitly "true": the challenge does not ask for committed
 * wagers to be reversed after a publication failure, so by default exhausted
 * recoveries stay in COMPENSATION_REQUIRED for an operator.
 */
export function isCompensationEnabled(value: unknown): boolean {
  return value === true || value === "true";
}

export function outboxSettings(configuration: ConfigReader): OutboxSettings {
  return {
    retryBaseDelayMs: configuration.getOrThrow<number>(
      "OUTBOX_RETRY_BASE_DELAY_MS",
    ),
    retryMaxDelayMs: configuration.getOrThrow<number>(
      "OUTBOX_RETRY_MAX_DELAY_MS",
    ),
    pollIntervalMs: configuration.getOrThrow<number>("OUTBOX_POLL_INTERVAL_MS"),
    batchSize: configuration.getOrThrow<number>("OUTBOX_BATCH_SIZE"),
    leaseMs: configuration.getOrThrow<number>("OUTBOX_LEASE_MS"),
    maxAttempts: configuration.getOrThrow<number>("OUTBOX_MAX_ATTEMPTS"),
  };
}

export function outboxPublisherSettings(
  configuration: ConfigReader,
): OutboxPublisherSettings {
  return {
    queueName: configuration.getOrThrow<string>("SQS_OUTBOX_QUEUE_NAME"),
    publishTimeoutMs: positiveInteger(
      configuration.get<string | number>("OUTBOX_PUBLISH_TIMEOUT_MS"),
      DEFAULT_OUTBOX_PUBLISH_TIMEOUT_MS,
    ),
  };
}

export function sqsEventSettings(
  configuration: ConfigReader,
): SqsEventSettings {
  return {
    batchSize: configuration.getOrThrow<number>("SQS_EVENT_BATCH_SIZE"),
    waitTimeSeconds: configuration.getOrThrow<number>(
      "SQS_EVENT_WAIT_TIME_SECONDS",
    ),
    visibilityTimeoutSeconds: configuration.getOrThrow<number>(
      "SQS_EVENT_VISIBILITY_TIMEOUT_SECONDS",
    ),
    retryVisibilitySeconds: configuration.getOrThrow<number>(
      "SQS_EVENT_RETRY_VISIBILITY_SECONDS",
    ),
    maxReceiveCount: configuration.getOrThrow<number>(
      "SQS_EVENT_MAX_RECEIVE_COUNT",
    ),
    pollIntervalMs: configuration.getOrThrow<number>(
      "SQS_EVENT_POLL_INTERVAL_MS",
    ),
  };
}

export function sqsQueueNames(configuration: ConfigReader): SqsQueueNames {
  return {
    outbox: configuration.getOrThrow<string>("SQS_OUTBOX_QUEUE_NAME"),
    event: configuration.getOrThrow<string>("SQS_EVENT_QUEUE_NAME"),
    eventDeadLetter: configuration.getOrThrow<string>("SQS_EVENT_DLQ_NAME"),
    wagerCommand: configuration.getOrThrow<string>(
      "SQS_WAGER_COMMAND_QUEUE_NAME",
    ),
    wagerCommandDeadLetter: configuration.getOrThrow<string>(
      "SQS_WAGER_COMMAND_DLQ_NAME",
    ),
  };
}

export function awsConnectionSettings(
  configuration: ConfigReader,
): AwsConnectionSettings {
  return {
    region: configuration.getOrThrow<string>("AWS_REGION"),
    endpoint: configuration.getOrThrow<string>("LOCALSTACK_ENDPOINT"),
    accessKeyId: configuration.getOrThrow<string>("AWS_ACCESS_KEY_ID"),
    secretAccessKey: configuration.getOrThrow<string>("AWS_SECRET_ACCESS_KEY"),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
