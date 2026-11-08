export interface ProviderRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ProviderRepository {
  findById(id: string): Promise<ProviderRow | null>;
  findByIdForShare(id: string): Promise<ProviderRow | null>;
  findByCode(code: string): Promise<ProviderRow | null>;
  create(
    provider: Pick<ProviderRow, "id" | "code" | "name" | "status">,
  ): Promise<ProviderRow>;
  updateStatus(id: string, status: string): Promise<ProviderRow | null>;
}

export interface PlayerRow {
  readonly id: string;
  readonly provider_id: string;
  readonly external_player_id: string;
  readonly status: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface PlayerRepository {
  findById(id: string): Promise<PlayerRow | null>;
  findByProviderAndExternalIdForShare(
    providerId: string,
    externalPlayerId: string,
  ): Promise<PlayerRow | null>;
  findByProviderAndExternalId(
    providerId: string,
    externalPlayerId: string,
  ): Promise<PlayerRow | null>;
  create(
    player: Pick<
      PlayerRow,
      "id" | "provider_id" | "external_player_id" | "status"
    >,
  ): Promise<PlayerRow>;
  updateStatus(
    providerId: string,
    playerId: string,
    status: string,
  ): Promise<PlayerRow | null>;
}

export interface WalletRow {
  readonly id: string;
  readonly provider_id: string;
  readonly player_id: string;
  readonly currency: string;
  readonly balance: string;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface WalletRepository {
  findById(id: string): Promise<WalletRow | null>;
  findByProviderAndId(
    providerId: string,
    id: string,
  ): Promise<WalletRow | null>;
  findByIdForUpdate(id: string): Promise<WalletRow | null>;
  findByPlayerAndCurrencyForUpdate(
    providerId: string,
    playerId: string,
    currency: string,
  ): Promise<WalletRow | null>;
  findByPlayerAndCurrency(
    providerId: string,
    playerId: string,
    currency: string,
  ): Promise<WalletRow | null>;
  findAllByProviderAndPlayer(
    providerId: string,
    playerId: string,
  ): Promise<WalletRow[]>;
  create(
    wallet: Pick<
      WalletRow,
      "id" | "provider_id" | "player_id" | "currency" | "balance" | "version"
    >,
  ): Promise<WalletRow>;
  updateBalance(
    id: string,
    expectedVersion: number,
    balance: string,
  ): Promise<WalletRow | null>;
}

export interface FinancialOperationRow {
  readonly id: string;
  readonly provider_id: string;
  readonly idempotency_key: string;
  readonly external_transaction_id: string;
  readonly payload_hash: string;
  readonly response_snapshot: unknown;
  readonly response_http_status: number;
  readonly created_at: Date;
  readonly completed_at: Date | null;
  /** Business flow that first submitted this operation; kept across retries. */
  readonly correlation_id: string | null;
}

export interface FinancialOperationRepository {
  findById(id: string): Promise<FinancialOperationRow | null>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<FinancialOperationRow | null>;
  findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<FinancialOperationRow | null>;
  create(
    operation: Pick<
      FinancialOperationRow,
      | "id"
      | "provider_id"
      | "idempotency_key"
      | "external_transaction_id"
      | "payload_hash"
      | "response_snapshot"
      | "response_http_status"
      | "completed_at"
    >,
  ): Promise<FinancialOperationRow>;
  reserve(
    operation: Pick<
      FinancialOperationRow,
      | "id"
      | "provider_id"
      | "idempotency_key"
      | "external_transaction_id"
      | "payload_hash"
      | "response_snapshot"
      | "response_http_status"
      | "completed_at"
      | "correlation_id"
    >,
  ): Promise<FinancialOperationRow | null>;
  complete(
    id: string,
    responseSnapshot: unknown,
    responseHttpStatus: number,
    completedAt: Date | null,
  ): Promise<FinancialOperationRow | null>;
}

export interface WagerTransactionRow {
  readonly id: string;
  readonly provider_id: string;
  readonly player_id: string;
  readonly wallet_id: string;
  readonly financial_operation_id: string | null;
  readonly external_transaction_id: string | null;
  readonly external_reference_transaction_id: string | null;
  readonly reference_transaction_id: string | null;
  readonly round_id: string | null;
  readonly game_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly amount: string;
  readonly currency: string;
  readonly failure_code: string | null;
  readonly reference_attempts: number;
  readonly next_reference_attempt_at: Date | null;
  readonly reference_expires_at: Date | null;
  readonly created_at: Date;
  readonly processed_at: Date | null;
  readonly completed_at: Date | null;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransactionRow | null>;
  findAllByProviderAndPlayer(
    providerId: string,
    playerId: string,
    limit: number,
    offset: number,
  ): Promise<WagerTransactionRow[]>;
  findDuePendingReferences(limit: number): Promise<WagerTransactionRow[]>;
  findByProviderAndExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null>;
  findByProviderAndExternalTransactionIdForUpdate(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRow | null>;
  findByIdForUpdate(id: string): Promise<WagerTransactionRow | null>;
  countPendingReferences(): Promise<number>;
  findProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransactionRow | null>;
  /**
   * The active result (WIN, LOSS or REFUND) of a BET, identified by the BET's
   * provider external ID within one wallet. Active means processed or still
   * waiting for the BET, and not reversed by a processed ROLLBACK. The caller
   * holds the wallet lock, which serializes every result of that BET.
   */
  findActiveBetResult(
    providerId: string,
    walletId: string,
    externalBetTransactionId: string,
    excludingTransactionId: string,
  ): Promise<WagerTransactionRow | null>;
  deferPendingReference(id: string, delayMs: number): Promise<boolean>;
  update(
    transaction: Pick<
      WagerTransactionRow,
      | "id"
      | "status"
      | "reference_transaction_id"
      | "failure_code"
      | "reference_attempts"
      | "next_reference_attempt_at"
      | "reference_expires_at"
      | "processed_at"
      | "completed_at"
    >,
  ): Promise<WagerTransactionRow | null>;
  create(
    transaction: Pick<
      WagerTransactionRow,
      | "id"
      | "provider_id"
      | "player_id"
      | "wallet_id"
      | "financial_operation_id"
      | "external_transaction_id"
      | "external_reference_transaction_id"
      | "reference_transaction_id"
      | "round_id"
      | "game_id"
      | "kind"
      | "status"
      | "amount"
      | "currency"
      | "failure_code"
      | "reference_attempts"
      | "next_reference_attempt_at"
      | "reference_expires_at"
      | "processed_at"
      | "completed_at"
    >,
  ): Promise<WagerTransactionRow>;
}

export interface WalletLedgerRow {
  readonly id: string;
  readonly provider_id: string;
  readonly player_id: string;
  readonly wallet_id: string;
  readonly wager_transaction_id: string;
  readonly amount: string;
  readonly entry_type: "CREDIT" | "DEBIT";
  readonly balance_before: string;
  readonly balance_after: string;
  readonly created_at: Date;
  readonly cursor_created_at?: string;
}

export interface WalletLedgerCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface WalletLedgerReconciliation {
  readonly stored_balance: string;
  readonly calculated_balance: string;
  readonly difference: string;
  readonly checked_entries: number;
}

export interface WalletLedgerRepository {
  findByTransactionId(transactionId: string): Promise<WalletLedgerRow | null>;
  findCursorPageByWallet(
    providerId: string,
    walletId: string,
    limit: number,
    cursor: WalletLedgerCursor | null,
  ): Promise<WalletLedgerRow[]>;
  reconcileWallet(
    providerId: string,
    walletId: string,
  ): Promise<WalletLedgerReconciliation | null>;
  create(
    entry: Pick<
      WalletLedgerRow,
      | "id"
      | "provider_id"
      | "player_id"
      | "wallet_id"
      | "wager_transaction_id"
      | "amount"
      | "entry_type"
      | "balance_before"
      | "balance_after"
    >,
  ): Promise<WalletLedgerRow>;
}

export interface InboxRow {
  readonly id: string;
  readonly consumer_name: string;
  readonly message_id: string;
  readonly payload_hash: string;
  readonly received_at: Date;
  readonly processed_at: Date;
}

export interface InboxRepository {
  findByConsumerAndMessage(
    consumerName: string,
    messageId: string,
  ): Promise<InboxRow | null>;
  createIfAbsent(
    message: Pick<
      InboxRow,
      | "id"
      | "consumer_name"
      | "message_id"
      | "payload_hash"
      | "received_at"
      | "processed_at"
    >,
  ): Promise<InboxRow | null>;
}

export interface OutboxRow {
  readonly id: string;
  readonly aggregate_id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly status: "PENDING" | "PROCESSING" | "PUBLISHED";
  readonly attempts: number;
  readonly next_attempt_at: Date;
  readonly locked_by: string | null;
  readonly locked_until: Date | null;
  readonly last_error: string | null;
  readonly created_at: Date;
  readonly published_at: Date | null;
}

export interface OutboxRepository {
  findById(id: string): Promise<OutboxRow | null>;
  findOldestUnpublishedAgeMs(): Promise<number>;
  create(
    event: Pick<OutboxRow, "id" | "aggregate_id" | "event_type" | "payload">,
  ): Promise<OutboxRow>;
  claimDue(
    workerId: string,
    limit: number,
    leaseMs: number,
  ): Promise<OutboxRow[]>;
  recoverExpiredLeases(): Promise<number>;
  markPublished(
    id: string,
    workerId: string,
    publishedAt: Date,
  ): Promise<boolean>;
  scheduleRetry(
    id: string,
    workerId: string,
    error: string,
    nextAttemptAt: Date,
    exhausted: boolean,
  ): Promise<boolean>;
  redriveFailed(limit: number): Promise<number>;
  countFailed(): Promise<number>;
}

export const WagerRecoveryStatus = {
  PENDING_RECOVERY: "PENDING_RECOVERY",
  RECOVERED: "RECOVERED",
  COMPENSATION_REQUIRED: "COMPENSATION_REQUIRED",
  COMPENSATED: "COMPENSATED",
  COMPENSATION_NOT_REQUIRED: "COMPENSATION_NOT_REQUIRED",
  COMPENSATION_REJECTED: "COMPENSATION_REJECTED",
  COMPENSATION_FAILED: "COMPENSATION_FAILED",
} as const;

export type WagerRecoveryStatus =
  (typeof WagerRecoveryStatus)[keyof typeof WagerRecoveryStatus];

export interface WagerRecoveryRow {
  readonly id: string;
  readonly wager_transaction_id: string;
  readonly provider_id: string;
  readonly wallet_id: string;
  readonly status: WagerRecoveryStatus;
  readonly recovery_attempts: number;
  readonly compensation_attempts: number;
  readonly next_compensation_attempt_at: Date | string;
  readonly last_error: string | null;
  readonly compensation_transaction_id: string | null;
  readonly failure_code: string | null;
  readonly detected_at: Date | string;
  readonly exhausted_at: Date | string | null;
  readonly resolved_at: Date | string | null;
}

/**
 * Post-commit recovery of a processed wager whose events could not be
 * published, and its compensation once recovery is exhausted.
 */
export interface WagerRecoveryRepository {
  /**
   * Records a failed publication of one of the wager's financial events.
   * Creates the recovery (PENDING_RECOVERY) or refreshes its attempt count.
   * Only a PROCESSED BET, WIN, LOSS or REFUND is tracked; anything else is a
   * no-op. `exhausted` moves it to COMPENSATION_REQUIRED.
   */
  recordPublicationFailure(
    wagerTransactionId: string,
    attempts: number,
    error: string,
    exhausted: boolean,
  ): Promise<void>;
  /** RECOVERED once every event of the wager is published. */
  markRecoveredIfPublished(wagerTransactionId: string): Promise<boolean>;
  findDueForCompensation(limit: number): Promise<WagerRecoveryRow[]>;
  findByIdForUpdateSkipLocked(id: string): Promise<WagerRecoveryRow | null>;
  findByWagerTransactionId(
    wagerTransactionId: string,
  ): Promise<WagerRecoveryRow | null>;
  resolve(
    id: string,
    status: WagerRecoveryStatus,
    compensationTransactionId: string | null,
    failureCode: string | null,
  ): Promise<void>;
  deferCompensation(
    id: string,
    delayMs: number,
    error: string,
    exhausted: boolean,
  ): Promise<boolean>;
}

export interface PersistenceSession {
  readonly recoveries: WagerRecoveryRepository;
  readonly providers: ProviderRepository;
  readonly players: PlayerRepository;
  readonly wallets: WalletRepository;
  readonly financialOperations: FinancialOperationRepository;
  readonly wagerTransactions: WagerTransactionRepository;
  readonly walletLedger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface TransactionManager {
  transaction<Result>(
    work: (session: PersistenceSession) => Promise<Result>,
  ): Promise<Result>;
}
