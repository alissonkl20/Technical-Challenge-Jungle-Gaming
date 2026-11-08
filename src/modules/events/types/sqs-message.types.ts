import type { ProcessWagerInput } from "../../transactions/types/index.js";

export interface WagerCommand {
  readonly messageId: string;
  /** The business flow that produced the command, when the producer sent it. */
  readonly correlationId?: string;
  readonly type: "WagerTransactionRequested";
  readonly data: {
    readonly providerId: string;
    readonly idempotencyKey: string;
    readonly playerId: string;
    readonly walletId: string;
    readonly input: Omit<ProcessWagerInput, "externalPlayerId">;
  };
}

export interface FinancialEventEnvelope {
  readonly event_id: string;
  readonly event_type: string;
  readonly aggregate_id: string;
  readonly payload: unknown;
  readonly correlation_id?: string;
}

export interface SqsBatchResult {
  readonly received: number;
  readonly acknowledged: number;
}
