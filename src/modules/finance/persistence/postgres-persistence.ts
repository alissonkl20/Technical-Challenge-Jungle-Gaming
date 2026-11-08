import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { hasErrorCode } from "../../../shared/errors/error-chain.js";
import type { FinancialMetrics } from "../../../shared/observability/financial-metrics.js";
import { setLockWaitObserver } from "../../../shared/observability/lock-wait.js";
import { PostgresFinancialOperationRepository } from "./financial-operation.repository.js";
import { PostgresInboxRepository } from "./inbox.repository.js";
import { PostgresOutboxRepository } from "./outbox.repository.js";
import { PostgresPlayerRepository } from "./player.repository.js";
import { PostgresProviderRepository } from "./provider.repository.js";
import type {
  FinancialOperationRepository,
  InboxRepository,
  OutboxRepository,
  PersistenceSession,
  PlayerRepository,
  ProviderRepository,
  TransactionManager,
  WagerRecoveryRepository,
  WagerTransactionRepository,
  WalletLedgerRepository,
  WalletRepository,
} from "./repositories.js";
import { PostgresWagerRecoveryRepository } from "./wager-recovery.repository.js";
import { PostgresWagerTransactionRepository } from "./wager-transaction.repository.js";
import { PostgresWalletRepository } from "./wallet.repository.js";
import { PostgresWalletLedgerRepository } from "./wallet-ledger.repository.js";

/** Deadlock and lock-not-available: counted as lock conflicts. */
const LOCK_CONFLICT_CODES: ReadonlySet<string> = new Set(["40P01", "55P03"]);
/**
 * Serialization failure and deadlock: PostgreSQL rolled the whole transaction
 * back, so it is safe to run it again from the start.
 */
const RETRYABLE_TRANSACTION_CODES: ReadonlySet<string> = new Set([
  "40001",
  "40P01",
]);

class PostgresPersistenceSession implements PersistenceSession {
  readonly recoveries: WagerRecoveryRepository;
  readonly providers: ProviderRepository;
  readonly players: PlayerRepository;
  readonly wallets: WalletRepository;
  readonly financialOperations: FinancialOperationRepository;
  readonly wagerTransactions: WagerTransactionRepository;
  readonly walletLedger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: PostgreSqlEntityManager) {
    this.recoveries = new PostgresWagerRecoveryRepository(em);
    this.providers = new PostgresProviderRepository(em);
    this.players = new PostgresPlayerRepository(em);
    this.wallets = new PostgresWalletRepository(em);
    this.financialOperations = new PostgresFinancialOperationRepository(em);
    this.wagerTransactions = new PostgresWagerTransactionRepository(em);
    this.walletLedger = new PostgresWalletLedgerRepository(em);
    this.inbox = new PostgresInboxRepository(em);
    this.outbox = new PostgresOutboxRepository(em);
  }
}

export class MikroOrmTransactionManager implements TransactionManager {
  constructor(
    private readonly em: PostgreSqlEntityManager,
    private readonly maxRetries = 3,
    private readonly metrics?: FinancialMetrics,
  ) {
    if (metrics !== undefined) {
      setLockWaitObserver((milliseconds) =>
        metrics.observeLockWait(milliseconds),
      );
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw new Error(
        "Transaction retry count must be an integer from 0 to 10",
      );
    }
  }

  transaction<Result>(
    work: (session: PersistenceSession) => Promise<Result>,
  ): Promise<Result> {
    return this.runWithRetry(work, 0);
  }

  private async runWithRetry<Result>(
    work: (session: PersistenceSession) => Promise<Result>,
    retries: number,
  ): Promise<Result> {
    try {
      return await this.em.transactional(
        async (em) => work(new PostgresPersistenceSession(em)),
        { clear: true },
      );
    } catch (error) {
      if (hasErrorCode(error, LOCK_CONFLICT_CODES)) {
        this.metrics?.recordLockConflict();
      }
      if (!hasErrorCode(error, RETRYABLE_TRANSACTION_CODES)) {
        throw error;
      }
      if (retries >= this.maxRetries) {
        throw error;
      }
      this.metrics?.recordRetry("database");
      return this.runWithRetry(work, retries + 1);
    }
  }
}
