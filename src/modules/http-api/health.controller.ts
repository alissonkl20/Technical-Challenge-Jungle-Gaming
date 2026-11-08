import { Controller, Get, Inject } from "@nestjs/common";
import { SqsEventConsumer } from "../events/sqs-event-consumer.service.js";
import { FinanceQueriesService } from "../finance/application/finance-queries.service.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(FinanceQueriesService)
    private readonly queries: Pick<FinanceQueriesService, "checkDatabase">,
    @Inject(SqsEventConsumer)
    private readonly sqs: Pick<SqsEventConsumer, "checkReady">,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    await this.queries.checkDatabase();
    await this.sqs.checkReady();
    return {
      status: "ok",
      dependencies: { postgres: "ok", sqs: "ok" },
    };
  }
}
