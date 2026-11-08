export type FinancialStatus =
  | "PENDING"
  | "PENDING_REFERENCE"
  | "PROCESSED"
  | "REJECTED"
  | "FAILED";

export type RetryComponent =
  | "database"
  | "outbox"
  | "pending_reference"
  | "sqs";

interface CounterSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  value: number;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class FinancialMetrics {
  private readonly counters = new Map<string, CounterSample>();
  private readonly latencyBucketCounts = LATENCY_BUCKETS.map(() => 0);
  private latencyCount = 0;
  private latencySum = 0;
  private outboxLagSeconds = 0;
  private outboxFailedEvents = 0;
  private pendingReferences = 0;
  private lockWaitCount = 0;
  private lockWaitSumMs = 0;
  private lockWaitMaxMs = 0;
  private outboxExhausted = 0;
  private dlqMessages = 0;
  private lockConflicts = 0;

  recordTransactionStatus(status: FinancialStatus): void {
    this.increment("wager_transactions_total", { status });
  }

  recordDuplicate(outcome: "replay" | "conflict"): void {
    this.increment("idempotency_duplicates_total", { outcome });
  }

  recordRetry(component: RetryComponent): void {
    this.increment("financial_retries_total", { component });
  }

  recordDeadLetter(): void {
    this.dlqMessages += 1;
  }

  recordLockConflict(): void {
    this.lockConflicts += 1;
  }

  recordReconciliation(consistent: boolean): void {
    this.increment("wallet_reconciliations_total", {
      result: consistent ? "consistent" : "inconsistent",
    });
  }

  observeProcessingDuration(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return;
    }
    const seconds = milliseconds / 1_000;
    this.latencyCount += 1;
    this.latencySum += seconds;
    LATENCY_BUCKETS.forEach((upperBound, index) => {
      if (seconds <= upperBound) {
        this.latencyBucketCounts[index] =
          (this.latencyBucketCounts[index] ?? 0) + 1;
      }
    });
  }

  setOutboxLagMilliseconds(milliseconds: number): void {
    this.outboxLagSeconds =
      Number.isFinite(milliseconds) && milliseconds > 0
        ? milliseconds / 1_000
        : 0;
  }

  /** Time spent in a locking read (SELECT ... FOR UPDATE / FOR SHARE). */
  observeLockWait(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      return;
    }
    this.lockWaitCount += 1;
    this.lockWaitSumMs += milliseconds;
    this.lockWaitMaxMs = Math.max(this.lockWaitMaxMs, milliseconds);
  }

  setPendingReferenceCount(count: number): void {
    this.pendingReferences = Number.isInteger(count) && count >= 0 ? count : 0;
  }

  /** An outbox event used all its publication attempts and became FAILED. */
  recordOutboxExhausted(): void {
    this.outboxExhausted += 1;
  }

  setOutboxFailedCount(count: number): void {
    this.outboxFailedEvents = Number.isInteger(count) && count >= 0 ? count : 0;
  }

  renderPrometheus(): string {
    const lines = [
      "# TYPE wager_transactions_total counter",
      ...this.renderCounters("wager_transactions_total"),
      "# TYPE idempotency_duplicates_total counter",
      ...this.renderCounters("idempotency_duplicates_total"),
      "# TYPE financial_retries_total counter",
      ...this.renderCounters("financial_retries_total"),
      "# TYPE sqs_messages_dead_letter_total counter",
      `sqs_messages_dead_letter_total ${this.dlqMessages}`,
      "# TYPE financial_lock_conflicts_total counter",
      `financial_lock_conflicts_total ${this.lockConflicts}`,
      "# TYPE wallet_reconciliations_total counter",
      ...this.renderCounters("wallet_reconciliations_total"),
      "# TYPE outbox_oldest_unpublished_age_seconds gauge",
      `outbox_oldest_unpublished_age_seconds ${this.outboxLagSeconds}`,
      "# TYPE outbox_failed_events gauge",
      `outbox_failed_events ${this.outboxFailedEvents}`,
      "# TYPE pending_references_open gauge",
      `pending_references_open ${this.pendingReferences}`,
      "# TYPE financial_lock_wait_milliseconds summary",
      `financial_lock_wait_milliseconds_sum ${this.lockWaitSumMs}`,
      `financial_lock_wait_milliseconds_count ${this.lockWaitCount}`,
      "# TYPE financial_lock_wait_milliseconds_max gauge",
      `financial_lock_wait_milliseconds_max ${this.lockWaitMaxMs}`,
      "# TYPE outbox_exhausted_total counter",
      `outbox_exhausted_total ${this.outboxExhausted}`,
      "# TYPE financial_processing_duration_seconds histogram",
      ...this.renderLatencyHistogram(),
    ];
    return `${lines.join("\n")}\n`;
  }

  private increment(
    name: string,
    labels: Readonly<Record<string, string>>,
  ): void {
    const key = `${name}:${JSON.stringify(labels)}`;
    const existing = this.counters.get(key);
    if (existing === undefined) {
      this.counters.set(key, { name, labels, value: 1 });
    } else {
      existing.value += 1;
    }
  }

  private renderCounters(name: string): string[] {
    return [...this.counters.values()]
      .filter((sample) => sample.name === name)
      .map((sample) => `${name}${formatLabels(sample.labels)} ${sample.value}`);
  }

  private renderLatencyHistogram(): string[] {
    const bucketLines = LATENCY_BUCKETS.map(
      (upperBound, index) =>
        `financial_processing_duration_seconds_bucket{le="${upperBound}"} ${this.latencyBucketCounts[index] ?? 0}`,
    );
    return [
      ...bucketLines,
      `financial_processing_duration_seconds_bucket{le="+Inf"} ${this.latencyCount}`,
      `financial_processing_duration_seconds_sum ${this.latencySum}`,
      `financial_processing_duration_seconds_count ${this.latencyCount}`,
    ];
  }
}

function formatLabels(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels);
  return entries.length === 0
    ? ""
    : `{${entries.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}
