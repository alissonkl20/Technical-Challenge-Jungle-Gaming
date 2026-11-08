import { Inject, Injectable } from "@nestjs/common";
import { withCorrelationId } from "../../shared/observability/request-context.js";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../finance/domain/index.js";
import type { TransactionManager } from "../finance/persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../finance/persistence/tokens.js";
import { PermanentReferenceError } from "./errors/index.js";
import type { WagerProcessingResult } from "./types/index.js";
import { WagerTransactionsService } from "./wager-transactions.service.js";

/** Resumes one PENDING_REFERENCE wager through the wager use case. */
@Injectable()
export class PendingReferenceRetryService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(WagerTransactionsService)
    private readonly wagers: WagerTransactionsService,
  ) {}

  async retry(transactionId: string): Promise<WagerProcessingResult | null> {
    const pending = await this.transactions.transaction((session) =>
      session.wagerTransactions.findById(transactionId),
    );
    if (
      pending === null ||
      pending.status !== WagerTransactionStatus.PENDING_REFERENCE
    ) {
      return null;
    }

    if (
      pending.financial_operation_id === null ||
      pending.external_transaction_id === null
    ) {
      throw new PermanentReferenceError(
        `Pending reference transaction "${transactionId}" has no financial context`,
      );
    }

    const operationId = pending.financial_operation_id;
    const externalTransactionId = pending.external_transaction_id;
    const [operation, player] = await this.transactions.transaction(
      async (session) =>
        Promise.all([
          session.financialOperations.findById(operationId),
          session.players.findById(pending.player_id),
        ]),
    );
    if (operation === null || player === null) {
      throw new PermanentReferenceError(
        `Pending reference transaction "${transactionId}" has missing financial context`,
      );
    }

    const kind = wagerTransactionKind(pending.kind);
    if (kind === null) {
      throw new PermanentReferenceError(
        `Pending reference transaction "${transactionId}" has an invalid kind`,
      );
    }

    // Resume under the flow that first submitted the operation. The pending
    // transaction is the cause of this work, not a new correlation.
    return withCorrelationId(
      operation.correlation_id ?? undefined,
      () =>
        this.wagers.process(pending.provider_id, operation.idempotency_key, {
          externalPlayerId: player.external_player_id,
          externalTransactionId,
          kind,
          amount: pending.amount,
          currency: pending.currency,
          ...(pending.external_reference_transaction_id === null
            ? {}
            : {
                externalReferenceTransactionId:
                  pending.external_reference_transaction_id,
              }),
          ...(pending.round_id === null ? {} : { roundId: pending.round_id }),
          ...(pending.game_id === null ? {} : { gameId: pending.game_id }),
        }),
      transactionId,
    );
  }
}

function wagerTransactionKind(value: string): WagerTransactionKind | null {
  return (
    Object.values(WagerTransactionKind).find(
      (candidate) => candidate === value,
    ) ?? null
  );
}
