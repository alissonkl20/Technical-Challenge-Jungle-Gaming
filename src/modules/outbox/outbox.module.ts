import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { outboxSettings } from "../../config/settings.js";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { JsonLogger } from "../../shared/observability/json-logger.js";
import { FinancePersistenceModule } from "../finance/persistence/finance-persistence.module.js";
import type { TransactionManager } from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import { SqsOutboxPublisher } from "./outbox.publisher.js";
import { OutboxService } from "./outbox.service.js";
import { OUTBOX_EVENT_PUBLISHER } from "./outbox.tokens.js";
import type { OutboxEventPublisher } from "./types/index.js";

@Module({
  imports: [FinancePersistenceModule],
  providers: [
    {
      provide: OUTBOX_EVENT_PUBLISHER,
      inject: [ConfigService],
      useFactory: (configuration: ConfigService) =>
        new SqsOutboxPublisher(configuration),
    },
    {
      provide: OutboxService,
      inject: [
        TRANSACTION_MANAGER,
        OUTBOX_EVENT_PUBLISHER,
        ConfigService,
        FinancialMetrics,
        JsonLogger,
      ],
      useFactory: (
        transactions: TransactionManager,
        publisher: OutboxEventPublisher,
        configuration: ConfigService,
        metrics: FinancialMetrics,
        logger: JsonLogger,
      ) => {
        const settings = outboxSettings(configuration);
        return new OutboxService(
          transactions,
          publisher,
          settings.retryBaseDelayMs,
          settings.retryMaxDelayMs,
          metrics,
          logger,
          settings.maxAttempts,
        );
      },
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}
