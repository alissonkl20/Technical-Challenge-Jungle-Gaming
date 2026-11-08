import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import mikroOrmConfig from "../mikro-orm.config.js";
import { validateEnvironment } from "./config/env.validation.js";
import { EventsModule } from "./modules/events/events.module.js";
import { HttpApiModule } from "./modules/http-api/http-api.module.js";
import { InboxModule } from "./modules/inbox/inbox.module.js";
import { OutboxModule } from "./modules/outbox/outbox.module.js";
import { PlayersModule } from "./modules/players/players.module.js";
import { ProvidersModule } from "./modules/providers/providers.module.js";
import { TransactionsModule } from "./modules/transactions/transactions.module.js";
import { WalletsModule } from "./modules/wallets/wallets.module.js";
import { DomainExceptionFilter } from "./shared/errors/index.js";
import { ObservabilityModule } from "./shared/observability/observability.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    ObservabilityModule,
    MikroOrmModule.forRoot(mikroOrmConfig),
    ProvidersModule,
    PlayersModule,
    WalletsModule,
    TransactionsModule,
    InboxModule,
    OutboxModule,
    EventsModule,
    HttpApiModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule {}
