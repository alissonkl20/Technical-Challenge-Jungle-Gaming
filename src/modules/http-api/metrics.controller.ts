import { Controller, Get, Header, Inject } from "@nestjs/common";
import { FinancialMetrics } from "../../shared/observability/financial-metrics.js";
import { OutboxService } from "../outbox/outbox.service.js";

@Controller()
export class MetricsController {
  constructor(
    @Inject(FinancialMetrics) private readonly metrics: FinancialMetrics,
    @Inject(OutboxService)
    private readonly outbox: Pick<OutboxService, "refreshLagMetric">,
  ) {}

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async scrape(): Promise<string> {
    await this.outbox.refreshLagMetric();
    return this.metrics.renderPrometheus();
  }
}
