export { spawn } from "node:child_process";
export { randomUUID } from "node:crypto";

import { randomUUID as randomUUIDInternal } from "node:crypto";

export { createServer } from "node:net";
export {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
export {
  type EntityManager as PostgreSqlEntityManager,
  MikroORM,
  type PostgreSqlDriver,
} from "@mikro-orm/postgresql";
export { ForbiddenException, UnauthorizedException } from "@nestjs/common";
export { ConfigService } from "@nestjs/config";
export { default as mikroOrmConfig } from "../../mikro-orm.config.js";
export { validateEnvironment } from "../../src/config/env.validation.js";
export { Migration20261106190000 } from "../../src/migrations/Migration20261106190000.js";
export { Migration20261106200000 } from "../../src/migrations/Migration20261106200000.js";
export { Migration20261106210000 } from "../../src/migrations/Migration20261106210000.js";
export { Migration20261107230000 } from "../../src/migrations/Migration20261107230000.js";
export { Migration20261108100000 } from "../../src/migrations/Migration20261108100000.js";
export { Migration20261108110000 } from "../../src/migrations/Migration20261108110000.js";
export { Migration20261108120000 } from "../../src/migrations/Migration20261108120000.js";
export { Migration20261108130000 } from "../../src/migrations/Migration20261108130000.js";
export { Migration20261108140000 } from "../../src/migrations/Migration20261108140000.js";
export { Migration20261108150000 } from "../../src/migrations/Migration20261108150000.js";
export { Migration20261108160000 } from "../../src/migrations/Migration20261108160000.js";
export { Migration20261109100000 } from "../../src/migrations/Migration20261109100000.js";
export { ProviderAuthService } from "../../src/modules/auth/provider-auth.service.js";
export { SqsEventConsumer } from "../../src/modules/events/sqs-event-consumer.service.js";
export { SqsWagerCommandConsumer } from "../../src/modules/events/sqs-wager-command-consumer.service.js";
export { FinanceQueriesService } from "../../src/modules/finance/application/finance-queries.service.js";
export {
  DuplicatePlayerError,
  DuplicateWalletError,
  FinancialOperationNotFoundError,
  IdempotencyConflictError,
  InactivePlayerError,
  InactiveProviderError,
  InvalidPayloadError,
  Money,
  ProviderAlreadyExistsError,
  WagerTransaction,
  WagerTransactionKind,
  WalletNotFoundError,
} from "../../src/modules/finance/domain/index.js";
export { MikroOrmTransactionManager } from "../../src/modules/finance/persistence/index.js";
export type {
  PersistenceSession,
  TransactionManager,
} from "../../src/modules/finance/persistence/repositories.js";
export { submitWagerTransactionDto } from "../../src/modules/http-api/dto/wagering-api.dto.js";
export { InboxPayloadConflictError } from "../../src/modules/inbox/errors/index.js";
export { InboxProcessor } from "../../src/modules/inbox/inbox.processor.js";
export { SqsOutboxPublisher } from "../../src/modules/outbox/outbox.publisher.js";
export { OutboxService } from "../../src/modules/outbox/outbox.service.js";
export type { OutboxMessage } from "../../src/modules/outbox/types/index.js";
export { PlayersService } from "../../src/modules/players/players.service.js";
export { ProvidersService } from "../../src/modules/providers/providers.service.js";
export { PendingReferenceRetryService } from "../../src/modules/transactions/pending-reference-retry.service.js";
export { PendingReferenceWorkerService } from "../../src/modules/transactions/pending-reference-worker.service.js";
export { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";
export { WalletsService } from "../../src/modules/wallets/wallets.service.js";
export { FinancialMetrics } from "../../src/shared/observability/financial-metrics.js";

/**
 * Builds a valid outbox row for tests that exercise outbox mechanics — claim,
 * lease, retry, publish — rather than event content.
 *
 * It mirrors `IntegrationEvent.toJSON()` because the publisher now refuses a
 * row whose payload is not the envelope it will send. Writing the envelope
 * here keeps those fixtures honest instead of loosening the publisher.
 */
export function outboxRowFixture(options: {
  readonly eventType: string;
  readonly aggregateId?: string;
  readonly data?: Record<string, unknown>;
  readonly eventId?: string;
  readonly correlationId?: string;
  readonly occurredAt?: Date;
  readonly version?: number;
}) {
  const eventId = options.eventId ?? randomUUIDInternal();
  const aggregateId = options.aggregateId ?? randomUUIDInternal();
  return {
    id: eventId,
    aggregate_id: aggregateId,
    event_type: options.eventType,
    payload: {
      eventId,
      eventType: options.eventType,
      aggregateId,
      correlationId: options.correlationId ?? eventId,
      occurredAt: (options.occurredAt ?? new Date()).toISOString(),
      version: options.version ?? 1,
      data: options.data ?? {},
    },
  };
}
