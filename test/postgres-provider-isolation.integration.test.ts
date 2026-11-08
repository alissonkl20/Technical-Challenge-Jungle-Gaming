import { describe, expect, test } from "bun:test";
import { SubmitWagerService } from "../src/modules/finance/application/submit-wager.service.js";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  ConfigService,
  DuplicatePlayerError,
  DuplicateWalletError,
  FinanceQueriesService,
  FinancialOperationNotFoundError,
  ForbiddenException,
  IdempotencyConflictError,
  InactivePlayerError,
  InactiveProviderError,
  Money,
  PlayersService,
  ProviderAlreadyExistsError,
  ProviderAuthService,
  ProvidersService,
  randomUUID,
  UnauthorizedException,
  validateEnvironment,
  WagerTransactionKind,
  WagerTransactionsService,
  WalletNotFoundError,
  WalletsService,
} from "./postgres-test-dependencies.js";
import { createWalletWithOpening } from "./support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL provider authentication and isolation",
  (integrationContext) => {
    describe("provider authentication and isolation", () => {
      test("registers providers, provider-scoped players, and isolated wallets", async () => {
        const providers = new ProvidersService(
          integrationContext.transactionManager,
        );
        const players = new PlayersService(
          integrationContext.transactionManager,
        );
        const wallets = new WalletsService(
          integrationContext.transactionManager,
        );

        const firstProvider = await providers.register({
          code: `provider-${randomUUID()}`,
          name: "First Provider",
        });

        const secondProvider = await providers.register({
          code: `provider-${randomUUID()}`,
          name: "Second Provider",
        });
        expect(firstProvider.status).toBe("ACTIVE");
        expect((await providers.findByCode(firstProvider.code)).id).toBe(
          firstProvider.id,
        );
        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.providers.create({
              id: randomUUID(),
              code: firstProvider.code,
              name: "Duplicate Provider",
              status: "ACTIVE",
            }),
          ),
        ).rejects.toBeInstanceOf(ProviderAlreadyExistsError);

        const firstPlayer = await players.register(firstProvider.id, {
          externalPlayerId: "shared-external-player",
        });
        const secondPlayer = await players.register(secondProvider.id, {
          externalPlayerId: "shared-external-player",
        });
        expect(firstPlayer.id).not.toBe(secondPlayer.id);
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
           (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'BRL', 0.00, 1)`,
            [randomUUID(), firstProvider.id, secondPlayer.id],
          ),
        ).rejects.toMatchObject({ code: "23503" });
        expect(
          (
            await players.findByExternalId(
              firstProvider.id,
              "shared-external-player",
            )
          ).id,
        ).toBe(firstPlayer.id);
        await expect(
          players.register(firstProvider.id, {
            externalPlayerId: "shared-external-player",
          }),
        ).rejects.toBeInstanceOf(DuplicatePlayerError);

        const wallet = await wallets.open(
          firstProvider.id,
          firstPlayer.id,
          "BRL",
        );
        expect(wallet.balance.toDecimal()).toBe("0.00");
        expect((await wallets.findById(firstProvider.id, wallet.id)).id).toBe(
          wallet.id,
        );
        expect(
          (
            await wallets.findByPlayerAndCurrency(
              firstProvider.id,
              firstPlayer.id,
              "BRL",
            )
          ).id,
        ).toBe(wallet.id);
        expect(
          (await wallets.findAllByPlayer(firstProvider.id, firstPlayer.id)).map(
            (item) => item.currency.toString(),
          ),
        ).toEqual(["BRL"]);
        await expect(
          wallets.findById(secondProvider.id, wallet.id),
        ).rejects.toBeInstanceOf(WalletNotFoundError);
        await expect(
          wallets.open(firstProvider.id, firstPlayer.id, "BRL"),
        ).rejects.toBeInstanceOf(DuplicateWalletError);

        await players.setStatus(firstProvider.id, firstPlayer.id, "SUSPENDED");
        await expect(
          wallets.open(firstProvider.id, firstPlayer.id, "USD"),
        ).rejects.toBeInstanceOf(InactivePlayerError);
        await providers.setStatus(firstProvider.id, "INACTIVE");
        await expect(
          players.register(firstProvider.id, {
            externalPlayerId: "cannot-register-inactive-provider",
          }),
        ).rejects.toBeInstanceOf(InactiveProviderError);
      });

      test("authenticates provider API keys and scopes wallet, Ledger, transaction, and operation queries", async () => {
        const providers = new ProvidersService(
          integrationContext.transactionManager,
        );
        const players = new PlayersService(
          integrationContext.transactionManager,
        );
        const wallets = new WalletsService(
          integrationContext.transactionManager,
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
          new ConfigService(validateEnvironment({})),
        );
        const queries = new FinanceQueriesService(
          integrationContext.transactionManager,
        );
        const provider = await providers.register({
          code: `api-${randomUUID()}`,
          name: "HTTP API Provider",
        });
        const secret = "api-secret-".padEnd(40, "x");
        const authentication = new ProviderAuthService(
          new ConfigService({
            PROVIDER_API_KEYS: { [provider.code]: secret },
          }),
          providers,
        );
        const authenticated = await authentication.authenticate(
          provider.code,
          secret,
        );
        expect(authenticated).toEqual({ id: provider.id, code: provider.code });
        await expect(
          authentication.authenticate(provider.code, "wrong-secret"),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        const player = await players.register(provider.id, {
          externalPlayerId: `api-player-${randomUUID()}`,
        });
        const wallet = await wallets.open(provider.id, player.id, "BRL", {
          amount: "20.00",
          currency: "BRL",
        });
        const transactionId = `api-bet-${randomUUID()}`;
        const result = await wagers.process(
          provider.id,
          `api-idempotency-${randomUUID()}`,
          integrationContext.wagerInput(
            player.externalPlayerId,
            transactionId,
            { amount: "12.00" },
          ),
        );
        expect(result.response.status).toBe("PROCESSED");
        const transactionRowId = result.response.transaction?.id;
        if (transactionRowId === undefined) {
          throw new Error(
            "Processed wager response did not include its transaction",
          );
        }

        expect(
          (await queries.findWalletById(authenticated, wallet.id)).balance,
        ).toBe("8.00");
        expect(
          (
            await queries.findTransactionByExternalId(
              authenticated,
              transactionId,
            )
          ).id,
        ).toBe(transactionRowId);
        expect(
          (
            await queries.listLedgerPageByWallet(
              authenticated,
              wallet.id,
              10,
              null,
            )
          ).items.map((item) => item.transactionId),
        ).toContain(transactionRowId);
        expect(
          await queries.getOperationStatus(authenticated, transactionId),
        ).toMatchObject({
          externalTransactionId: transactionId,
          status: "PROCESSED",
          pending: false,
        });

        await providers.setStatus(provider.id, "INACTIVE");
        await expect(
          authentication.authenticate(provider.code, secret),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });

      test("simulates concurrent BET1 and BET2 betting with provider isolation, idempotency, and wallet contention", async () => {
        const providers = new ProvidersService(
          integrationContext.transactionManager,
        );
        const players = new PlayersService(
          integrationContext.transactionManager,
        );
        const wallets = new WalletsService(
          integrationContext.transactionManager,
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
          new ConfigService(validateEnvironment({})),
        );
        const bet1Provider = await providers.register({
          code: "BET1",
          name: "BET1",
        });
        const bet2Provider = await providers.register({
          code: "BET2",
          name: "BET2",
        });
        const bet1ApiKey = `bet1-test-${randomUUID()}`;
        const bet2ApiKey = `bet2-test-${randomUUID()}`;
        const authentication = new ProviderAuthService(
          new ConfigService({
            PROVIDER_API_KEYS: {
              [bet1Provider.code]: bet1ApiKey,
              [bet2Provider.code]: bet2ApiKey,
            },
          }),
          providers,
        );
        const [bet1Session, bet2Session] = await Promise.all([
          authentication.authenticate(bet1Provider.code, bet1ApiKey),
          authentication.authenticate(bet2Provider.code, bet2ApiKey),
        ]);

        const bet1Players = new Map<
          number,
          {
            readonly id: string;
            readonly walletId: string;
            readonly externalId: string;
          }
        >();
        const bet2Players = new Map<
          number,
          {
            readonly id: string;
            readonly walletId: string;
            readonly externalId: string;
          }
        >();
        for (let playerNumber = 1; playerNumber <= 12; playerNumber += 1) {
          const externalId = `player${playerNumber}`;
          if (playerNumber <= 8) {
            const player = await players.register(bet1Session.id, {
              externalPlayerId: externalId,
            });
            const wallet = await wallets.open(
              bet1Session.id,
              player.id,
              "BRL",
              {
                amount: "100.00",
                currency: "BRL",
              },
            );
            bet1Players.set(playerNumber, {
              id: player.id,
              walletId: wallet.id,
              externalId,
            });
          }

          const player = await players.register(bet2Session.id, {
            externalPlayerId: externalId,
          });
          const wallet = await wallets.open(bet2Session.id, player.id, "BRL", {
            amount: "100.00",
            currency: "BRL",
          });
          bet2Players.set(playerNumber, {
            id: player.id,
            walletId: wallet.id,
            externalId,
          });
        }

        const playersForProvider = [
          ...[...bet1Players.entries()].map(([number, player]) => ({
            provider: bet1Session,
            playerNumber: number,
            player,
          })),
          ...[...bet2Players.entries()].map(([number, player]) => ({
            provider: bet2Session,
            playerNumber: number,
            player,
          })),
        ];

        const simultaneousBets = playersForProvider.map(
          ({ provider, playerNumber, player }) => ({
            provider,
            playerNumber,
            player,
            key: `round-1-player${playerNumber}`,
            input: integrationContext.wagerInput(
              player.externalId,
              `round-1-player${playerNumber}`,
              {
                amount: "10.00",
              },
            ),
          }),
        );
        const firstResults = await Promise.all(
          simultaneousBets.map(({ provider, key, input }) =>
            wagers.process(provider.id, key, input),
          ),
        );
        expect(
          firstResults.every(
            (result) => result.response.status === "PROCESSED",
          ),
        ).toBe(true);

        const bet1Player1 = simultaneousBets.find(
          ({ provider, playerNumber }) =>
            provider.id === bet1Session.id && playerNumber === 1,
        );
        const bet2Player1 = simultaneousBets.find(
          ({ provider, playerNumber }) =>
            provider.id === bet2Session.id && playerNumber === 1,
        );
        if (bet1Player1 === undefined || bet2Player1 === undefined) {
          throw new Error(
            "The shared player betting requests were not created",
          );
        }
        expect(bet1Player1.key).toBe(bet2Player1.key);
        expect(bet1Player1.input.externalTransactionId).toBe(
          bet2Player1.input.externalTransactionId,
        );
        const duplicateResults = await Promise.all(
          Array.from({ length: 50 }, () =>
            wagers.process(bet1Session.id, bet1Player1.key, bet1Player1.input),
          ),
        );
        expect(
          duplicateResults.every(
            (result) =>
              result.response.transaction?.id ===
              firstResults[simultaneousBets.indexOf(bet1Player1)]?.response
                .transaction?.id,
          ),
        ).toBe(true);

        await expect(
          wagers.process(bet1Session.id, bet1Player1.key, {
            ...bet1Player1.input,
            amount: "11.00",
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);

        const [bet1Wallet, bet2Wallet] = await Promise.all([
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.findById(bet1Players.get(1)?.walletId ?? ""),
          ),
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.findById(bet2Players.get(1)?.walletId ?? ""),
          ),
        ]);
        expect(bet1Players.get(1)?.id).not.toBe(bet2Players.get(1)?.id);
        expect(bet1Players.get(1)?.walletId).not.toBe(
          bet2Players.get(1)?.walletId,
        );
        expect(bet1Wallet?.provider_id).toBe(bet1Session.id);
        expect(bet2Wallet?.provider_id).toBe(bet2Session.id);
        expect(bet1Wallet?.balance).toBe("90.00");
        expect(bet2Wallet?.balance).toBe("90.00");

        const bet2Player12 = bet2Players.get(12);
        if (bet2Player12 === undefined) {
          throw new Error("BET2 player12 was not created");
        }
        const competingBets = await Promise.all([
          wagers.process(
            bet2Session.id,
            "BET2:player12:race-A",
            integrationContext.wagerInput(
              bet2Player12.externalId,
              "player12-race-A",
              {
                amount: "60.00",
              },
            ),
          ),
          wagers.process(
            bet2Session.id,
            "BET2:player12:race-B",
            integrationContext.wagerInput(
              bet2Player12.externalId,
              "player12-race-B",
              {
                amount: "60.00",
              },
            ),
          ),
        ]);
        expect(
          competingBets.map((result) => result.response.status).sort(),
        ).toEqual(["PROCESSED", "REJECTED"]);
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(bet2Player12.walletId),
            )
          )?.balance,
        ).toBe("30.00");

        const absentBet1Player =
          await integrationContext.transactionManager.transaction((session) =>
            session.players.findByProviderAndExternalId(
              bet1Session.id,
              "player9",
            ),
          );
        expect(absentBet1Player).toBeNull();

        for (const { player } of playersForProvider) {
          await integrationContext.expectWalletBalanceMatchesLedger(
            player.walletId,
          );
        }
        expect(
          await integrationContext.orm.em.execute<{ count: string }[]>(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".wallet_ledger_entries
         WHERE wallet_id = ?
           AND wager_transaction_id IN (
             SELECT id FROM "${integrationContext.schema}".wager_transactions
             WHERE external_transaction_id = 'round-1-player1'
           )`,
            [bet1Players.get(1)?.walletId],
          ),
        ).toEqual([{ count: "1" }]);
        expect(
          await integrationContext.orm.em.execute<{ count: string }[]>(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".wallet_ledger_entries
         WHERE wallet_id = ?
           AND wager_transaction_id IN (
             SELECT id FROM "${integrationContext.schema}".wager_transactions
             WHERE external_transaction_id = 'round-1-player1'
           )`,
            [bet2Players.get(1)?.walletId],
          ),
        ).toEqual([{ count: "1" }]);
      });

      test("isolates four providers with identical player and transaction identifiers", async () => {
        const providers = new ProvidersService(
          integrationContext.transactionManager,
        );
        const players = new PlayersService(
          integrationContext.transactionManager,
        );
        const wallets = new WalletsService(
          integrationContext.transactionManager,
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
          new ConfigService(validateEnvironment({})),
        );
        const queries = new FinanceQueriesService(
          integrationContext.transactionManager,
        );
        const providerDefinitions = ["BET1", "BET2", "BET3", "BET4"].map(
          (label) => ({
            label,
            code: `${label}-${randomUUID()}`,
            apiKey: `${label}-secret-${randomUUID()}`,
          }),
        );
        const providerContexts = await Promise.all(
          providerDefinitions.map(async ({ label, code }) => {
            const provider = await providers.register({ code, name: label });
            const player = await players.register(provider.id, {
              externalPlayerId: "player_123",
            });
            const wallet = await wallets.open(provider.id, player.id, "BRL", {
              amount: "100.00",
              currency: "BRL",
            });
            return { label, provider, player, wallet };
          }),
        );
        const apiKeys = Object.fromEntries(
          providerDefinitions.map(({ code, apiKey }) => [code, apiKey]),
        );
        const authentication = new ProviderAuthService(
          new ConfigService({ PROVIDER_API_KEYS: apiKeys }),
          providers,
        );
        const authenticatedProviders = await Promise.all(
          providerDefinitions.map(({ code, apiKey }) =>
            authentication.authenticate(code, apiKey),
          ),
        );
        await expect(
          authentication.authenticate(
            providerDefinitions[1]?.code ?? "BET2",
            providerDefinitions[0]?.apiKey ?? "",
          ),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        const sharedExternalId = `shared-provider-transaction-${randomUUID()}`;

        const betAmounts = ["20.00", "30.00", "40.00", "50.00"];
        const bets = await Promise.all(
          providerContexts.map(({ provider }, index) =>
            wagers.process(
              provider.id,
              "shared-bet-key",
              integrationContext.wagerInput("player_123", sharedExternalId, {
                amount: betAmounts[index] ?? "20.00",
              }),
            ),
          ),
        );
        expect(bets.map((result) => result.response.status)).toEqual([
          "PROCESSED",
          "PROCESSED",
          "PROCESSED",
          "PROCESSED",
        ]);
        expect(
          new Set(bets.map((result) => result.response.transaction?.id)).size,
        ).toBe(4);
        expect(
          new Set(providerContexts.map(({ player }) => player.id)).size,
        ).toBe(4);
        expect(
          new Set(providerContexts.map(({ wallet }) => wallet.id)).size,
        ).toBe(4);

        for (const [index, context] of providerContexts.entries()) {
          const expectedBalance = Money.fromDecimal("100.00", "BRL")
            .subtract(Money.fromDecimal(betAmounts[index] ?? "20.00", "BRL"))
            .toDecimal();
          const queryProvider = authenticatedProviders[index];
          if (queryProvider === undefined) {
            throw new Error(
              `Missing authenticated provider for ${context.provider.code}`,
            );
          }

          const queriedWallet = await queries.findWalletById(
            queryProvider,
            context.wallet.id,
          );
          expect(queriedWallet.id).toBe(context.wallet.id);
          expect(queriedWallet.providerId).toBe(context.provider.id);
          expect(queriedWallet.balance).toBe(expectedBalance);

          // The same external ID resolves to this provider's own transaction.
          const transaction = await queries.findTransactionByExternalId(
            queryProvider,
            sharedExternalId,
          );
          expect(transaction.id).toBe(
            bets[index]?.response.transaction?.id ?? "",
          );
          expect(transaction.providerId).toBe(context.provider.id);
          // No provider can read a wallet of another.
          for (const otherContext of providerContexts) {
            if (otherContext.provider.id === context.provider.id) continue;
            await expect(
              queries.findWalletById(queryProvider, otherContext.wallet.id),
            ).rejects.toBeInstanceOf(WalletNotFoundError);
          }

          const ledger = (
            await queries.listLedgerPageByWallet(
              queryProvider,
              context.wallet.id,
              20,
              null,
            )
          ).items;
          expect(
            ledger.every((entry) => entry.providerId === context.provider.id),
          ).toBe(true);
          expect(
            ledger.some(
              (entry) =>
                entry.transactionId === bets[index]?.response.transaction?.id,
            ),
          ).toBe(true);
          expect(
            await queries.getOperationStatus(queryProvider, sharedExternalId),
          ).toMatchObject({
            externalTransactionId: sharedExternalId,
            status: "PROCESSED",
            pending: false,
          });
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.wallet.id,
          );
        }

        const bet2 = providerContexts[1];
        const bet3 = providerContexts[2];
        const bet1 = providerContexts[0];
        const bet4 = providerContexts[3];
        if (
          bet1 === undefined ||
          bet2 === undefined ||
          bet3 === undefined ||
          bet4 === undefined
        ) {
          throw new Error("Four provider contexts were not initialized");
        }
        const bet1Authenticated = authenticatedProviders[0];
        if (bet1Authenticated === undefined) {
          throw new Error("BET1 authentication context was not initialized");
        }
        await wagers.process(
          bet2.provider.id,
          `bet2-exclusive-key-${randomUUID()}`,
          integrationContext.wagerInput("player_123", "bet2-exclusive-target", {
            amount: "5.00",
          }),
        );
        await wagers.process(
          bet3.provider.id,
          `bet3-exclusive-key-${randomUUID()}`,
          integrationContext.wagerInput("player_123", "bet3-exclusive-target", {
            amount: "5.00",
          }),
        );

        const crossProviderRefundId = `cross-refund-${randomUUID()}`;
        const crossProviderRollbackId = `cross-rollback-${randomUUID()}`;
        const [crossProviderRefund, crossProviderRollback] = await Promise.all([
          wagers.process(
            bet1.provider.id,
            `cross-refund-key-${randomUUID()}`,
            integrationContext.wagerInput("player_123", crossProviderRefundId, {
              kind: WagerTransactionKind.REFUND,
              amount: "5.00",
              externalReferenceTransactionId: "bet2-exclusive-target",
            }),
          ),
          wagers.process(
            bet4.provider.id,
            `cross-rollback-key-${randomUUID()}`,
            integrationContext.wagerInput(
              "player_123",
              crossProviderRollbackId,
              {
                kind: WagerTransactionKind.ROLLBACK,
                amount: "5.00",
                externalReferenceTransactionId: "bet3-exclusive-target",
              },
            ),
          ),
        ]);
        expect(crossProviderRefund.response.status).toBe("PENDING_REFERENCE");
        expect(crossProviderRollback.response.status).toBe("PENDING_REFERENCE");
        expect(crossProviderRefund.response.wallet?.balance).toBe("80.00");
        expect(crossProviderRollback.response.wallet?.balance).toBe("50.00");
        const crossProviderReferences = await integrationContext.orm.em.execute<
          {
            external_transaction_id: string;
            provider_id: string;
            wallet_id: string;
            status: string;
            reference_transaction_id: string | null;
            ledger_count: string;
          }[]
        >(
          `SELECT wager.external_transaction_id,
              wager.provider_id,
              wager.wallet_id,
              wager.status,
              wager.reference_transaction_id,
              (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries entry
               WHERE entry.wager_transaction_id = wager.id) AS ledger_count
       FROM "${integrationContext.schema}".wager_transactions wager
       WHERE wager.provider_id IN (?, ?)
         AND wager.external_transaction_id IN (?, ?)
       ORDER BY wager.external_transaction_id`,
          [
            bet1.provider.id,
            bet4.provider.id,
            crossProviderRefundId,
            crossProviderRollbackId,
          ],
        );
        expect(crossProviderReferences).toEqual(
          [
            {
              external_transaction_id: crossProviderRefundId,
              provider_id: bet1.provider.id,
              wallet_id: bet1.wallet.id,
              status: "PENDING_REFERENCE",
              reference_transaction_id: null,
              ledger_count: "0",
            },
            {
              external_transaction_id: crossProviderRollbackId,
              provider_id: bet4.provider.id,
              wallet_id: bet4.wallet.id,
              status: "PENDING_REFERENCE",
              reference_transaction_id: null,
              ledger_count: "0",
            },
          ].sort((left, right) =>
            left.external_transaction_id.localeCompare(
              right.external_transaction_id,
            ),
          ),
        );

        await expect(
          queries.getOperationStatus(
            bet1Authenticated,
            "bet2-exclusive-target",
          ),
        ).rejects.toBeInstanceOf(FinancialOperationNotFoundError);
        await expect(
          queries.findWalletById(bet1Authenticated, bet2.wallet.id),
        ).rejects.toBeInstanceOf(WalletNotFoundError);

        // A provider naming another provider's player or wallet on the
        // published contract is refused as a recorded business rejection, and
        // the other provider's wallet is untouched.
        const submission = new SubmitWagerService(
          integrationContext.transactionManager,
          wagers,
        );
        const bet2Before = (
          await integrationContext.transactionManager.transaction((session) =>
            session.wallets.findById(bet2.wallet.id),
          )
        )?.balance;
        const forgedPlayer = await submission.submit(
          bet1Authenticated.id,
          "forged-player-request",
          {
            playerId: bet2.player.id,
            walletId: bet2.wallet.id,
            externalTransactionId: "forged-player-request",
            kind: "BET",
            money: { amount: "1.00", currency: "BRL" },
          },
        );
        expect(forgedPlayer).toMatchObject({
          status: "REJECTED",
          failureCode: "PLAYER_NOT_FOUND",
          httpStatus: 422,
        });
        const forgedWallet = await submission.submit(
          bet1Authenticated.id,
          "forged-wallet-request",
          {
            playerId: bet1.player.id,
            walletId: bet2.wallet.id,
            externalTransactionId: "forged-wallet-request",
            kind: "BET",
            money: { amount: "1.00", currency: "BRL" },
          },
        );
        expect(forgedWallet).toMatchObject({
          status: "REJECTED",
          failureCode: "WALLET_NOT_FOUND",
        });
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(bet2.wallet.id),
            )
          )?.balance,
        ).toBe(bet2Before);

        for (const { wallet } of providerContexts) {
          await integrationContext.expectWalletBalanceMatchesLedger(wallet.id);
        }
      });

      test("enforces wallet uniqueness, currency/provider isolation, and version updates", async () => {
        const providerId = randomUUID();
        const playerId = randomUUID();
        const walletId = randomUUID();

        await integrationContext.transactionManager.transaction(
          async (session) => {
            await session.providers.create({
              id: providerId,
              code: "constraint-provider",
              name: "Constraint Provider",
              status: "ACTIVE",
            });

            await session.players.create({
              id: playerId,
              provider_id: providerId,
              external_player_id: "constraint-player",
              status: "ACTIVE",
            });
            await createWalletWithOpening(session, {
              id: walletId,
              provider_id: providerId,
              player_id: playerId,
              currency: "USD",
              balance: "1.00",
              version: 1,
            });
          },
        );

        expect(
          await integrationContext.transactionManager.transaction((session) =>
            session.wallets.findByProviderAndId(randomUUID(), walletId),
          ),
        ).toBeNull();
        await expect(
          integrationContext.orm.em.execute(
            `UPDATE "${integrationContext.schema}".wallets SET balance = '-0.01' WHERE id = ?`,
            [walletId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
          (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'BRL', '-0.01', 1)`,
            [randomUUID(), providerId, playerId],
          ),
        ).rejects.toThrow();

        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              currency: "USD",
              balance: "0.00",
              version: 1,
            }),
          ),
        ).rejects.toBeInstanceOf(DuplicateWalletError);

        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.create({
              id: randomUUID(),
              provider_id: randomUUID(),
              player_id: playerId,
              currency: "EUR",
              balance: "0.00",
              version: 1,
            }),
          ),
        ).rejects.toThrow();

        await integrationContext.transactionManager.transaction(
          async (session) => {
            const operationId = randomUUID();
            const wagerId = randomUUID();
            const updated = await session.wallets.updateBalance(
              walletId,
              1,
              "0.00",
            );
            expect(updated?.balance).toBe("0.00");
            expect(updated?.version).toBe(2);
            expect(
              await session.wallets.updateBalance(walletId, 1, "3.00"),
            ).toBeNull();
            expect(
              await session.wallets.updateBalance(walletId, 2, "0.00"),
            ).toBeNull();
            await session.financialOperations.create({
              id: operationId,
              provider_id: providerId,
              idempotency_key: "wallet-version-key",
              external_transaction_id: "wallet-version-operation",
              payload_hash: "a".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: new Date(),
            });
            await session.wagerTransactions.create({
              id: wagerId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: operationId,
              external_transaction_id: "wallet-version-operation",
              external_reference_transaction_id: null,
              reference_transaction_id: null,
              round_id: null,
              game_id: null,
              kind: "BET",
              status: "PROCESSED",
              amount: "1.00",
              currency: "USD",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
            await session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: wagerId,
              amount: "1.00",
              entry_type: "DEBIT",
              balance_before: "1.00",
              balance_after: "0.00",
            });
          },
        );
      });
    });
  },
);
