export interface PendingReferenceBatchResult {
  readonly examined: number;
  readonly completed: number;
  readonly retried: number;
  readonly failed: number;
  readonly failures: readonly string[];
}

export interface CompensationBatchResult {
  readonly examined: number;
  readonly resolved: Readonly<Record<string, number>>;
  readonly deferred: number;
}
