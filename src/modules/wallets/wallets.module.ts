import { Module } from "@nestjs/common";
import { FinancePersistenceModule } from "../finance/persistence/finance-persistence.module.js";
import { WalletsService } from "./wallets.service.js";

@Module({
  imports: [FinancePersistenceModule],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
