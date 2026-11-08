import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { EventsModule } from "../events/events.module.js";
import { FinanceApplicationModule } from "../finance/application/finance-application.module.js";
import { OutboxModule } from "../outbox/outbox.module.js";
import { ProvidersController } from "../providers/providers.controller.js";
import { ProvidersModule } from "../providers/providers.module.js";
import { WalletsModule } from "../wallets/wallets.module.js";
import { HealthController } from "./health.controller.js";
import { MetricsController } from "./metrics.controller.js";
import { WageringApiController } from "./wagering-api.controller.js";

/**
 * `ProvidersController` is registered here rather than in `ProvidersModule`:
 * its guards come from `AuthModule`, which itself imports `ProvidersModule`.
 */
@Module({
  imports: [
    AuthModule,
    FinanceApplicationModule,
    ProvidersModule,
    OutboxModule,
    EventsModule,
    WalletsModule,
  ],
  controllers: [
    HealthController,
    MetricsController,
    WageringApiController,
    ProvidersController,
  ],
})
export class HttpApiModule {}
