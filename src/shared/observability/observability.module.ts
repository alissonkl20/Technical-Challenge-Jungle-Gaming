import { Global, Module } from "@nestjs/common";
import { FinancialMetrics } from "./financial-metrics.js";
import { JsonLogger } from "./json-logger.js";

@Global()
@Module({
  providers: [
    FinancialMetrics,
    {
      provide: JsonLogger,
      useFactory: () => new JsonLogger(),
    },
  ],
  exports: [FinancialMetrics, JsonLogger],
})
export class ObservabilityModule {}
