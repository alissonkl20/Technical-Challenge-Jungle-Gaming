import { MikroORM as PostgreSqlMikroORM } from "@mikro-orm/postgresql";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { databaseTransactionMaxRetries } from "../../../config/settings.js";
import { FinancialMetrics } from "../../../shared/observability/financial-metrics.js";
import { MikroOrmTransactionManager } from "./postgres-persistence.js";
import { TRANSACTION_MANAGER } from "./tokens.js";

@Module({
  providers: [
    {
      provide: TRANSACTION_MANAGER,
      inject: [PostgreSqlMikroORM, ConfigService, FinancialMetrics],
      useFactory: (
        orm: PostgreSqlMikroORM,
        config: ConfigService,
        metrics: FinancialMetrics,
      ) =>
        new MikroOrmTransactionManager(
          orm.em,
          databaseTransactionMaxRetries(config),
          metrics,
        ),
    },
  ],
  exports: [TRANSACTION_MANAGER],
})
export class FinancePersistenceModule {}
