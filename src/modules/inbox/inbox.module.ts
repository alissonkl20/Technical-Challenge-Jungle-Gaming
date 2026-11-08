import { Module } from "@nestjs/common";
import { FinancePersistenceModule } from "../finance/persistence/finance-persistence.module.js";
import { InboxProcessor } from "./inbox.processor.js";

@Module({
  imports: [FinancePersistenceModule],
  providers: [InboxProcessor],
  exports: [InboxProcessor],
})
export class InboxModule {}
