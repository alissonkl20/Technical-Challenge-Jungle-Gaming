import { Module } from "@nestjs/common";
import { FinancePersistenceModule } from "../finance/persistence/finance-persistence.module.js";
import { PendingReferenceRetryService } from "./pending-reference-retry.service.js";
import { PendingReferenceWorkerService } from "./pending-reference-worker.service.js";
import { WagerCompensationService } from "./wager-compensation.service.js";
import { WagerTransactionsService } from "./wager-transactions.service.js";

@Module({
  imports: [FinancePersistenceModule],
  providers: [
    WagerTransactionsService,
    PendingReferenceRetryService,
    PendingReferenceWorkerService,
    WagerCompensationService,
  ],
  exports: [
    WagerTransactionsService,
    PendingReferenceWorkerService,
    WagerCompensationService,
  ],
})
export class TransactionsModule {}
