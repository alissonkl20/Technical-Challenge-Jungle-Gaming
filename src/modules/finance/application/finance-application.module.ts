import { Module } from "@nestjs/common";
import { TransactionsModule } from "../../transactions/transactions.module.js";
import { FinancePersistenceModule } from "../persistence/finance-persistence.module.js";
import { FinanceQueriesService } from "./finance-queries.service.js";
import { SubmitWagerService } from "./submit-wager.service.js";

/**
 * The finance read and write entry points. Interface adapters import this
 * module instead of the persistence module, which is what keeps column names
 * and SQL sessions out of the HTTP layer.
 */
@Module({
  imports: [FinancePersistenceModule, TransactionsModule],
  providers: [FinanceQueriesService, SubmitWagerService],
  exports: [FinanceQueriesService, SubmitWagerService],
})
export class FinanceApplicationModule {}
