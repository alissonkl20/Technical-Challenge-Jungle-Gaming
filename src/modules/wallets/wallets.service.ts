import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  eventContext,
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../events/integration-event.js";
import { walletFromRow } from "../finance/application/domain-row.mapper.js";
import {
  playerId as asPlayerId,
  providerId as asProviderId,
  walletId as asWalletId,
  currencyCode,
  InactivePlayerError,
  InactiveProviderError,
  InvalidMoneyError,
  LedgerDirection,
  type LedgerEntrySnapshot,
  Money,
  PlayerNotFoundError,
  PlayerStatus,
  ProviderNotFoundError,
  ProviderStatus,
  WagerTransaction,
  Wallet,
  WalletLedgerEntry,
  WalletNotFoundError,
} from "../finance/domain/index.js";
import {
  type PersistenceSession,
  TRANSACTION_MANAGER,
  type TransactionManager,
  type WalletRow,
} from "../finance/persistence/index.js";
import { toWagerTransactionRow } from "../transactions/wager-transaction.mapper.js";

@Injectable()
export class WalletsService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
  ) {}

  open(
    providerId: string,
    playerId: string,
    currency: string,
    initialBalance?: { readonly amount: string; readonly currency: string },
  ): Promise<Wallet> {
    const openingMoney =
      initialBalance === undefined
        ? Money.zero(currency)
        : Money.fromDecimal(initialBalance.amount, initialBalance.currency);
    if (openingMoney.isNegative()) {
      throw new InvalidMoneyError("Initial balance cannot be negative");
    }
    if (openingMoney.currency !== currency) {
      throw new InvalidMoneyError(
        "Initial balance currency must match wallet currency",
      );
    }
    const id = randomUUID();

    return this.transactions.transaction(async (session) => {
      const { providers, players, wallets } = session;
      const provider = await providers.findById(providerId);
      if (!provider) {
        throw new ProviderNotFoundError(
          `Provider "${providerId}" was not found`,
        );
      }
      if (provider.status !== ProviderStatus.ACTIVE) {
        throw new InactiveProviderError(`Provider "${providerId}" is inactive`);
      }

      const player = await players.findById(playerId);
      if (!player || player.provider_id !== providerId) {
        throw new PlayerNotFoundError(`Player "${playerId}" was not found`);
      }
      if (player.status !== PlayerStatus.ACTIVE) {
        throw new InactivePlayerError(`Player "${playerId}" is suspended`);
      }

      const wallet = Wallet.rehydrate({
        id,
        providerId,
        playerId,
        currency: openingMoney.currency,
        balance: openingMoney.toDecimal(),
        version: 1,
      });
      const snapshot = wallet.snapshot();
      const createdWallet = await wallets.create({
        id: snapshot.id,
        provider_id: snapshot.providerId,
        player_id: snapshot.playerId,
        currency: snapshot.currency,
        balance: snapshot.balance,
        version: snapshot.version,
      });

      if (openingMoney.isPositive()) {
        await this.persistOpening(session, createdWallet, openingMoney);
      }

      return walletFromRow(createdWallet);
    });
  }

  private async persistOpening(
    session: PersistenceSession,
    wallet: WalletRow,
    amount: Money,
  ): Promise<void> {
    const opening = WagerTransaction.createOpening({
      id: randomUUID(),
      providerId: wallet.provider_id,
      playerId: wallet.player_id,
      walletId: wallet.id,
      amount: amount.toDecimal(),
      currency: amount.currency,
    });
    opening.markProcessed();
    const transaction = toWagerTransactionRow(opening.snapshot(), null, null);
    await session.wagerTransactions.create(transaction);
    // The opening credit is part of creating the wallet, so the balance is
    // already final and the version stays at 1. The entry is still built by
    // the domain, which verifies its arithmetic.
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: opening.ledgerDirectionFor() ?? LedgerDirection.Credit,
      money: amount,
      balanceBefore: Money.zero(amount.currency),
      balanceAfter: amount,
    }).snapshot();
    await session.walletLedger.create({
      id: entry.id,
      provider_id: wallet.provider_id,
      player_id: wallet.player_id,
      wallet_id: entry.walletId,
      wager_transaction_id: entry.transactionId,
      amount: entry.amount,
      entry_type: entry.direction,
      balance_before: entry.balanceBefore,
      balance_after: entry.balanceAfter,
    });
    await publishOpeningEvents(session, wallet, transaction, entry);
  }

  findById(providerId: string, walletId: string): Promise<Wallet> {
    const validatedProviderId = asProviderId(providerId);
    const validatedWalletId = asWalletId(walletId);
    return this.transactions.transaction(async ({ providers, wallets }) => {
      if (!(await providers.findById(validatedProviderId))) {
        throw new ProviderNotFoundError(
          `Provider "${validatedProviderId}" was not found`,
        );
      }

      const row = await wallets.findByProviderAndId(
        validatedProviderId,
        validatedWalletId,
      );
      if (!row) {
        throw new WalletNotFoundError(
          `Wallet "${validatedWalletId}" was not found`,
        );
      }
      return walletFromRow(row);
    });
  }

  findByPlayerAndCurrency(
    providerId: string,
    playerId: string,
    currency: string,
  ): Promise<Wallet> {
    const supportedCurrency = currencyCode(currency);
    const validatedProviderId = asProviderId(providerId);
    const validatedPlayerId = asPlayerId(playerId);
    return this.transactions.transaction(
      async ({ providers, players, wallets }) => {
        if (!(await providers.findById(validatedProviderId))) {
          throw new ProviderNotFoundError(
            `Provider "${validatedProviderId}" was not found`,
          );
        }
        const player = await players.findById(validatedPlayerId);
        if (!player || player.provider_id !== validatedProviderId) {
          throw new PlayerNotFoundError(
            `Player "${validatedPlayerId}" was not found`,
          );
        }

        const row = await wallets.findByPlayerAndCurrency(
          validatedProviderId,
          validatedPlayerId,
          supportedCurrency,
        );
        if (!row) {
          throw new WalletNotFoundError(
            `Wallet in ${currency} was not found for player "${validatedPlayerId}"`,
          );
        }
        return walletFromRow(row);
      },
    );
  }

  findAllByPlayer(providerId: string, playerId: string): Promise<Wallet[]> {
    const validatedProviderId = asProviderId(providerId);
    const validatedPlayerId = asPlayerId(playerId);
    return this.transactions.transaction(
      async ({ providers, players, wallets }) => {
        if (!(await providers.findById(validatedProviderId))) {
          throw new ProviderNotFoundError(
            `Provider "${validatedProviderId}" was not found`,
          );
        }
        const player = await players.findById(validatedPlayerId);
        if (!player || player.provider_id !== validatedProviderId) {
          throw new PlayerNotFoundError(
            `Player "${validatedPlayerId}" was not found`,
          );
        }

        const rows = await wallets.findAllByProviderAndPlayer(
          validatedProviderId,
          validatedPlayerId,
        );
        return rows.map(walletFromRow);
      },
    );
  }
}

/**
 * The opening credit is a real financial fact, so it publishes the same two
 * events as any other movement.
 */
async function publishOpeningEvents(
  session: PersistenceSession,
  wallet: WalletRow,
  transaction: ReturnType<typeof toWagerTransactionRow>,
  entry: LedgerEntrySnapshot,
): Promise<void> {
  const context = eventContext();

  await session.outbox.create(
    WagerTransactionProcessed.from(
      {
        wagerTransactionId: transaction.id,
        providerId: wallet.provider_id,
        kind: transaction.kind,
        money: { amount: transaction.amount, currency: transaction.currency },
      },
      context,
    ).toOutboxRow(),
  );
  await session.outbox.create(
    WalletBalanceChanged.from(
      {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction: entry.direction,
        money: { amount: entry.amount, currency: entry.currency },
        balanceBefore: {
          amount: entry.balanceBefore,
          currency: entry.currency,
        },
        balanceAfter: {
          amount: entry.balanceAfter,
          currency: entry.currency,
        },
        walletVersion: wallet.version,
      },
      context,
    ).toOutboxRow(),
  );
}
