import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";
import { createWalletWithOpening } from "./support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL wallet concurrency and response replay",
  (integrationContext) => {
    describe("wallet concurrency and response replay", () => {
      test("runs concurrent bets on different wallets with independent balances", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const usdWalletId = randomUUID();
        await integrationContext.transactionManager.transaction((session) =>
          createWalletWithOpening(session, {
            id: usdWalletId,
            provider_id: context.providerId,
            player_id: context.playerId,
            currency: "USD",
            balance: "100.00",
            version: 1,
          }),
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );

        const results = await Promise.all([
          wagers.process(
            context.providerId,
            `different-wallet-brl-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `different-wallet-brl-${randomUUID()}`,
              {
                amount: "70.00",
              },
            ),
          ),
          wagers.process(
            context.providerId,
            `different-wallet-usd-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `different-wallet-usd-${randomUUID()}`,
              {
                amount: "40.00",
                currency: "USD",
              },
            ),
          ),
        ]);

        expect(results.map((result) => result.response.status)).toEqual([
          "PROCESSED",
          "PROCESSED",
        ]);
        const balances =
          await integrationContext.transactionManager.transaction(
            async (session) => ({
              brl: await session.wallets.findById(context.walletId),
              usd: await session.wallets.findById(usdWalletId),
            }),
          );
        expect(balances.brl?.balance).toBe("30.00");
        expect(balances.usd?.balance).toBe("60.00");
      });

      test("uses separate PostgreSQL connections for concurrent transactions", async () => {
        let arrivals = 0;
        let release!: () => void;
        const bothConnected = new Promise<void>((resolve) => {
          release = resolve;
        });

        const backendPid = () =>
          integrationContext.orm.em.transactional(async (em) => {
            const rows = await em.execute<{ pid: number }[]>(
              "SELECT pg_backend_pid() AS pid",
            );
            const pid = rows[0]?.pid;
            if (pid === undefined) {
              throw new Error(
                "PostgreSQL did not return the backend process ID",
              );
            }
            arrivals += 1;
            if (arrivals === 2) {
              release();
            }
            await bothConnected;
            return pid;
          });

        const pids = await Promise.all([backendPid(), backendPid()]);
        expect(new Set(pids).size).toBe(2);
      });

      test("replays the committed result when the original HTTP response is lost", async () => {
        const context = await integrationContext.seedWagerContext("25.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `lost-response-${randomUUID()}`,
          { amount: "7.00" },
        );
        const key = `lost-response-key-${randomUUID()}`;

        const committedResponse = await wagers.process(
          context.providerId,
          key,
          input,
        );
        const replayedResponse = await wagers.process(
          context.providerId,
          key,
          input,
        );

        expect(replayedResponse).toEqual({
          ...committedResponse,
          idempotentReplay: true,
        });
        const state = await integrationContext.transactionManager.transaction(
          async (session) => ({
            wallet: await session.wallets.findById(context.walletId),
            ledger: await session.walletLedger.findByTransactionId(
              committedResponse.response.transaction?.id ?? "",
            ),
          }),
        );
        expect(state.wallet?.balance).toBe("18.00");
        expect(state.ledger).not.toBeNull();
      });

      test("replays the original response snapshot after a later operation changes the balance", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const betInput = integrationContext.wagerInput(
          context.externalPlayerId,
          `snapshot-bet-${randomUUID()}`,
          { amount: "20.00" },
        );
        const betKey = `snapshot-bet-key-${randomUUID()}`;
        const originalBet = await wagers.process(
          context.providerId,
          betKey,
          betInput,
        );
        expect(originalBet.response.wallet?.balance).toBe("80.00");

        const win = await wagers.process(
          context.providerId,
          `snapshot-win-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `snapshot-win-${randomUUID()}`,
            {
              kind: WagerTransactionKind.WIN,
              amount: "7.00",
              externalReferenceTransactionId: betInput.externalTransactionId,
            },
          ),
        );
        expect(win.response.wallet?.balance).toBe("87.00");

        const replay = await wagers.process(
          context.providerId,
          betKey,
          betInput,
        );
        expect(replay).toEqual({ ...originalBet, idempotentReplay: true });
        expect(replay.response.wallet?.balance).toBe("80.00");
        const state = await integrationContext.transactionManager.transaction(
          async (session) => ({
            wallet: await session.wallets.findById(context.walletId),
            operation: await session.financialOperations.findByIdempotencyKey(
              context.providerId,
              betKey,
            ),
            wager:
              await session.wagerTransactions.findByProviderAndExternalTransactionId(
                context.providerId,
                betInput.externalTransactionId,
              ),
            ledger: await session.walletLedger.findByTransactionId(
              originalBet.response.transaction?.id ?? "",
            ),
          }),
        );
        expect(state.wallet?.balance).toBe("87.00");
        expect(state.operation?.response_snapshot).toEqual(
          originalBet.response,
        );
        expect(state.wager?.id).toBe(originalBet.response.transaction?.id);
        expect(state.ledger).not.toBeNull();
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });
    });
  },
);
