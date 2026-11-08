import { Module } from "@nestjs/common";
import { InboxModule } from "../inbox/inbox.module.js";
import { TransactionsModule } from "../transactions/transactions.module.js";
import { SqsEventConsumer } from "./sqs-event-consumer.service.js";
import { SqsWagerCommandConsumer } from "./sqs-wager-command-consumer.service.js";

@Module({
  imports: [InboxModule, TransactionsModule],
  providers: [SqsEventConsumer, SqsWagerCommandConsumer],
  exports: [SqsEventConsumer, SqsWagerCommandConsumer],
})
export class EventsModule {}
