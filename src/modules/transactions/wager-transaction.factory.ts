import { randomUUID } from "node:crypto";
import {
  type Player,
  type Provider,
  WagerTransaction,
  WagerTransactionStatus,
  type Wallet,
} from "../finance/domain/index.js";
import type {
  FinancialOperationRow,
  WagerTransactionRow,
} from "../finance/persistence/repositories.js";
import type { NormalizedWagerInput } from "./types/index.js";

interface CreateOrRehydrateWagerInput {
  readonly provider: Provider;
  readonly player: Player;
  readonly wallet: Wallet;
  readonly operation: FinancialOperationRow;
  readonly input: NormalizedWagerInput;
  readonly payloadHash: string;
  readonly existingPending: WagerTransactionRow | null;
}

export function createOrRehydrateWager({
  provider,
  player,
  wallet,
  operation,
  input,
  payloadHash,
  existingPending,
}: CreateOrRehydrateWagerInput): WagerTransaction {
  if (existingPending !== null) {
    return WagerTransaction.rehydrate({
      id: existingPending.id,
      providerId: existingPending.provider_id,
      playerId: existingPending.player_id,
      walletId: existingPending.wallet_id,
      financialOperationId: operation.id,
      externalTransactionId: existingPending.external_transaction_id,
      idempotencyKey: operation.idempotency_key,
      payloadFingerprint: operation.payload_hash,
      externalReferenceTransactionId:
        existingPending.external_reference_transaction_id,
      referenceTransactionId: existingPending.reference_transaction_id,
      roundId: existingPending.round_id,
      gameId: existingPending.game_id,
      kind: existingPending.kind as NormalizedWagerInput["kind"],
      status: WagerTransactionStatus.PENDING_REFERENCE,
      amount: existingPending.amount,
      currency: existingPending.currency,
      failureCode: null,
      createdAt: new Date(existingPending.created_at).toISOString(),
      processedAt: null,
      completedAt: null,
    });
  }

  return WagerTransaction.create({
    id: randomUUID(),
    providerId: provider.id,
    playerId: player.id,
    walletId: wallet.id,
    financialOperationId: operation.id,
    externalTransactionId: input.externalTransactionId,
    idempotencyKey: operation.idempotency_key,
    payloadFingerprint: payloadHash,
    kind: input.kind,
    amount: input.amount,
    currency: input.currency,
    ...(input.externalReferenceTransactionId === undefined
      ? {}
      : {
          externalReferenceTransactionId: input.externalReferenceTransactionId,
        }),
    ...(input.roundId === undefined ? {} : { roundId: input.roundId }),
    ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
  });
}
