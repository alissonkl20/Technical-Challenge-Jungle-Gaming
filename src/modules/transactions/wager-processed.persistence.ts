import {
  eventContext,
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../events/integration-event.js";
import {
  type WagerTransaction,
  WagerTransactionStatus,
  type Wallet,
  type WalletMovement,
} from "../finance/domain/index.js";
import type {
  FinancialOperationRow,
  PersistenceSession,
  PlayerRow,
  WagerTransactionRow,
  WalletRow,
} from "../finance/persistence/repositories.js";
import type {
  WagerProcessingResponse,
  WagerProcessingResult,
} from "./types/index.js";
import { completeFinancialOperation } from "./wager-operation.persistence.js";
import { toWagerTransactionRow } from "./wager-transaction.mapper.js";

interface PersistProcessedWagerInput {
  readonly session: PersistenceSession;
  readonly operation: FinancialOperationRow;
  readonly player: PlayerRow;
  readonly walletRow: WalletRow;
  readonly wallet: Wallet;
  readonly wager: WagerTransaction;
  readonly externalTransactionId: string;
  readonly movement: WalletMovement | null;
  readonly existingPending: WagerTransactionRow | null;
  readonly referenceAttempts: number;
}

export async function persistProcessedWager({
  session,
  operation,
  player,
  walletRow,
  wallet,
  wager,
  externalTransactionId,
  movement,
  existingPending,
  referenceAttempts,
}: PersistProcessedWagerInput): Promise<WagerProcessingResult> {
  wager.markProcessed();
  const snapshot = wager.snapshot();
  const transaction = toWagerTransactionRow(
    snapshot,
    null,
    null,
    existingPending === null ? 0 : referenceAttempts + 1,
  );

  if (existingPending === null) {
    await session.wagerTransactions.create(transaction);
  } else {
    const updated = await session.wagerTransactions.update({
      id: transaction.id,
      status: transaction.status,
      reference_transaction_id: transaction.reference_transaction_id,
      failure_code: transaction.failure_code,
      reference_attempts: transaction.reference_attempts,
      next_reference_attempt_at: transaction.next_reference_attempt_at,
      reference_expires_at: transaction.reference_expires_at,
      processed_at: transaction.processed_at,
      completed_at: transaction.completed_at,
    });
    if (updated === null) {
      throw new Error("Pending wager disappeared before it was processed");
    }
  }

  if (movement !== null) {
    await persistWalletMovement(session, player, walletRow, wallet, movement);
  }

  const response: WagerProcessingResponse = {
    externalTransactionId,
    status: WagerTransactionStatus.PROCESSED,
    transaction: snapshot,
    wallet: wallet.snapshot(),
    failureCode: null,
  };
  await persistProcessedEvents(session, wallet, wager, movement);
  await completeFinancialOperation(
    session,
    operation.id,
    response,
    200,
    new Date(),
  );

  return { httpStatus: 200, idempotentReplay: false, response };
}

async function persistWalletMovement(
  session: PersistenceSession,
  player: PlayerRow,
  walletRow: WalletRow,
  wallet: Wallet,
  movement: WalletMovement,
): Promise<void> {
  const snapshot = wallet.snapshot();
  const updatedWallet = await session.wallets.updateBalance(
    snapshot.id,
    walletRow.version,
    snapshot.balance,
  );
  if (updatedWallet === null) {
    throw new Error("Locked wallet changed before its balance update");
  }

  // The ledger row is the entry the aggregate produced, not a value
  // recomputed here: balance and entry cannot drift apart.
  const entry = movement.entry.snapshot();
  await session.walletLedger.create({
    id: entry.id,
    provider_id: wallet.providerId,
    player_id: player.id,
    wallet_id: entry.walletId,
    wager_transaction_id: entry.transactionId,
    amount: entry.amount,
    entry_type: entry.direction,
    balance_before: entry.balanceBefore,
    balance_after: entry.balanceAfter,
  });
}

async function persistProcessedEvents(
  session: PersistenceSession,
  wallet: Wallet,
  wager: WagerTransaction,
  movement: WalletMovement | null,
): Promise<void> {
  const walletSnapshot = wallet.snapshot();
  // One context for both events, so they share a correlation ID and an
  // occurrence instant: they describe the same committed fact.
  const context = eventContext();

  await session.outbox.create(
    WagerTransactionProcessed.from(
      {
        wagerTransactionId: wager.id,
        providerId: walletSnapshot.providerId,
        kind: wager.kind,
        money: wager.amount.toJSON(),
      },
      context,
    ).toOutboxRow(),
  );

  // LOSS and any rejected operation move no money, so no balance event is
  // published. Publishing one with a zero amount would tell a consumer that
  // the balance changed when it did not.
  if (movement === null) {
    return;
  }

  await session.outbox.create(
    WalletBalanceChanged.from(
      {
        walletId: walletSnapshot.id,
        transactionId: wager.id,
        direction: movement.direction,
        money: movement.money.toJSON(),
        balanceBefore: movement.balanceBefore.toJSON(),
        balanceAfter: movement.balanceAfter.toJSON(),
        walletVersion: walletSnapshot.version,
      },
      context,
    ).toOutboxRow(),
  );
}
