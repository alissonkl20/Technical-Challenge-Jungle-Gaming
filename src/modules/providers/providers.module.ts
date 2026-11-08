import { Module } from "@nestjs/common";
import { FinancePersistenceModule } from "../finance/persistence/finance-persistence.module.js";
import { ProvidersService } from "./providers.service.js";

@Module({
  imports: [FinancePersistenceModule],
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
