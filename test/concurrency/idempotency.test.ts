import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../support/postgres-integration-context.js";
import {
  FinancialMetrics,
  IdempotencyConflictError,
  Money,
  PlayersService,
  ProvidersService,
  randomUUID,
  WagerTransactionsService,
  WalletsService,
} from "../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL idempotency and cross-process deduplication",
  (integrationContext) => {
    describe("idempotency and cross-process deduplication", () => {
      test("deduplicates concurrent requests with the same idempotency identity", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          "same-concurrent-bet",
        );
        const results = await Promise.all([
          wagers.process(context.providerId, "same-concurrent-key", input),
          wagers.process(context.providerId, "same-concurrent-key", input),
        ]);

        expect(results[0]?.response).toEqual(results[1]?.response);
        expect(results[0]?.httpStatus).toBe(results[1]?.httpStatus ?? 0);
        expect(results.filter((result) => result.idempotentReplay).length).toBe(
          1,
        );
        const counts = await integrationContext.orm.em.execute<
          { ledger_count: string; wager_count: string }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ?
            AND wager_transaction_id IN (
              SELECT id FROM "${integrationContext.schema}".wager_transactions WHERE kind <> 'OPENING'
            )) AS ledger_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE wallet_id = ? AND kind <> 'OPENING') AS wager_count`,
          [context.walletId, context.walletId],
        );
        expect(counts[0]?.ledger_count).toBe("1");
        expect(counts[0]?.wager_count).toBe("1");
      });

      test("replays 30 identical concurrent requests with one operation, wager, and debit", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `duplicate-30-${randomUUID()}`,
        );
        const idempotencyKey = `duplicate-30-key-${randomUUID()}`;
        const results = await Promise.all(
          Array.from({ length: 30 }, () =>
            wagers.process(context.providerId, idempotencyKey, input),
          ),
        );

        expect(
          results.every((result) => result.response.status === "PROCESSED"),
        ).toBe(true);
        expect(results.every((result) => result.httpStatus === 200)).toBe(true);
        expect(results.map((result) => result.response)).toEqual(
          Array.from({ length: 30 }, () => results[0]?.response),
        );
        const counts = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND idempotency_key = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND wager_transaction_id IN (
            SELECT id FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS ledger_count`,
          [
            context.providerId,
            idempotencyKey,
            context.providerId,
            input.externalTransactionId,
            context.walletId,
            context.providerId,
            input.externalTransactionId,
          ],
        );
        expect(counts[0]).toEqual({
          operation_count: "1",
          wager_count: "1",
          ledger_count: "1",
        });
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            )
          )?.balance,
        ).toBe("90.00");
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("rejects 29 concurrent payload variants under one idempotency key", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const externalTransactionId = `variant-30-${randomUUID()}`;
        const idempotencyKey = `variant-30-key-${randomUUID()}`;
        const inputs = Array.from({ length: 30 }, (_, index) =>
          integrationContext.wagerInput(
            context.externalPlayerId,
            externalTransactionId,
            {
              amount: `${index + 1}.00`,
            },
          ),
        );
        const outcomes = await Promise.allSettled(
          inputs.map((input) =>
            wagers.process(context.providerId, idempotencyKey, input),
          ),
        );
        const accepted = outcomes.flatMap((outcome, index) =>
          outcome.status === "fulfilled"
            ? [{ outcome, input: inputs[index] }]
            : [],
        );
        const conflicts = outcomes.filter(
          (outcome) => outcome.status === "rejected",
        );

        expect(accepted).toHaveLength(1);
        expect(conflicts).toHaveLength(29);
        expect(
          conflicts.every(
            (outcome) =>
              outcome.status === "rejected" &&
              outcome.reason instanceof IdempotencyConflictError,
          ),
        ).toBe(true);
        const acceptedInput = accepted[0]?.input;
        const acceptedResult = accepted[0]?.outcome.value;
        if (acceptedInput === undefined || acceptedResult === undefined) {
          throw new Error("No idempotent payload variant was accepted");
        }

        const counts = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND idempotency_key = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND wager_transaction_id IN (
            SELECT id FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS ledger_count`,
          [
            context.providerId,
            idempotencyKey,
            context.providerId,
            externalTransactionId,
            context.walletId,
            context.providerId,
            externalTransactionId,
          ],
        );
        expect(counts[0]).toEqual({
          operation_count: "1",
          wager_count: "1",
          ledger_count: "1",
        });
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            )
          )?.balance,
        ).toBe(
          Money.fromDecimal("100.00", "BRL")
            .subtract(Money.fromDecimal(acceptedInput.amount, "BRL"))
            .toDecimal(),
        );
        expect(
          await wagers.process(
            context.providerId,
            idempotencyKey,
            acceptedInput,
          ),
        ).toEqual({ ...acceptedResult, idempotentReplay: true });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("deduplicates 30 different idempotency keys for one external transaction", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `external-id-30-${randomUUID()}`,
        );
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, index) =>
            wagers.process(
              context.providerId,
              `external-id-key-${index}-${randomUUID()}`,
              input,
            ),
          ),
        );

        expect(results.map((result) => result.response)).toEqual(
          Array.from({ length: 30 }, () => results[0]?.response),
        );
        expect(
          results.every((result) => result.response.status === "PROCESSED"),
        ).toBe(true);
        const counts = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND wager_transaction_id IN (
            SELECT id FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS ledger_count`,
          [
            context.providerId,
            input.externalTransactionId,
            context.providerId,
            input.externalTransactionId,
            context.walletId,
            context.providerId,
            input.externalTransactionId,
          ],
        );
        expect(counts[0]).toEqual({
          operation_count: "1",
          wager_count: "1",
          ledger_count: "1",
        });
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            )
          )?.balance,
        ).toBe("90.00");
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("scopes identical idempotency keys and external IDs independently by provider", async () => {
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
        );
        const contexts = await Promise.all(
          ["BET-IDEMPOTENCY-A", "BET-IDEMPOTENCY-B"].map(async (code) => {
            const provider = await providers.register({ code, name: code });
            const player = await players.register(provider.id, {
              externalPlayerId: "shared-player",
            });
            const wallet = await wallets.open(provider.id, player.id, "BRL", {
              amount: "100.00",
              currency: "BRL",
            });
            return { provider, player, wallet };
          }),
        );
        const sharedKey = `same-key-${randomUUID()}`;
        const sharedExternalId = `same-external-id-${randomUUID()}`;
        const results: Awaited<ReturnType<typeof wagers.process>>[] = [];
        for (const { provider } of contexts) {
          results.push(
            await wagers.process(
              provider.id,
              sharedKey,
              integrationContext.wagerInput("shared-player", sharedExternalId),
            ),
          );
        }

        expect(results.map((result) => result.response.status)).toEqual([
          "PROCESSED",
          "PROCESSED",
        ]);
        expect(results[0]?.response.transaction?.id).not.toBe(
          results[1]?.response.transaction?.id,
        );
        const replays = await Promise.all(
          contexts.map(({ provider }) =>
            wagers.process(
              provider.id,
              sharedKey,
              integrationContext.wagerInput("shared-player", sharedExternalId),
            ),
          ),
        );
        expect(
          replays.map((result) => result.response.transaction?.id),
        ).toEqual(results.map((result) => result.response.transaction?.id));

        const persisted = await Promise.all(
          contexts.map(async ({ provider, player, wallet }) => {
            const operation =
              await integrationContext.transactionManager.transaction(
                (session) =>
                  session.financialOperations.findByIdempotencyKey(
                    provider.id,
                    sharedKey,
                  ),
              );
            const wager =
              await integrationContext.transactionManager.transaction(
                (session) =>
                  session.wagerTransactions.findByProviderAndExternalTransactionId(
                    provider.id,
                    sharedExternalId,
                  ),
              );
            const storedWallet =
              await integrationContext.transactionManager.transaction(
                (session) => session.wallets.findById(wallet.id),
              );
            return { provider, player, wallet, operation, wager, storedWallet };
          }),
        );
        expect(persisted[0]?.provider.id).not.toBe(persisted[1]?.provider.id);
        expect(persisted[0]?.player.id).not.toBe(persisted[1]?.player.id);
        expect(persisted[0]?.wallet.id).not.toBe(persisted[1]?.wallet.id);
        expect(persisted.every((item) => item.operation !== null)).toBe(true);
        expect(persisted.every((item) => item.wager !== null)).toBe(true);
        expect(persisted.map((item) => item.storedWallet?.balance)).toEqual([
          "90.00",
          "90.00",
        ]);
        for (const { wallet } of contexts) {
          await integrationContext.expectWalletBalanceMatchesLedger(wallet.id);
        }
      });

      test("rejects payload variants that reuse one provider external transaction ID", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const externalTransactionId = `external-variant-${randomUUID()}`;
        const inputs = Array.from({ length: 30 }, (_, index) =>
          integrationContext.wagerInput(
            context.externalPlayerId,
            externalTransactionId,
            {
              amount: `${index + 1}.00`,
            },
          ),
        );
        const outcomes = await Promise.allSettled(
          inputs.map((input, index) =>
            wagers.process(
              context.providerId,
              `external-variant-key-${index}-${randomUUID()}`,
              input,
            ),
          ),
        );
        const accepted = outcomes.flatMap((outcome, index) =>
          outcome.status === "fulfilled"
            ? [{ outcome, input: inputs[index] }]
            : [],
        );
        const conflicts = outcomes.filter(
          (outcome) => outcome.status === "rejected",
        );

        expect(accepted).toHaveLength(1);
        expect(conflicts).toHaveLength(29);
        expect(
          conflicts.every(
            (outcome) =>
              outcome.status === "rejected" &&
              outcome.reason instanceof IdempotencyConflictError,
          ),
        ).toBe(true);
        const acceptedInput = accepted[0]?.input;
        const acceptedResult = accepted[0]?.outcome.value;
        if (acceptedInput === undefined || acceptedResult === undefined) {
          throw new Error(
            "No external transaction payload variant was accepted",
          );
        }

        const counts = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND wager_transaction_id IN (
            SELECT id FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS ledger_count`,
          [
            context.providerId,
            externalTransactionId,
            context.providerId,
            externalTransactionId,
            context.walletId,
            context.providerId,
            externalTransactionId,
          ],
        );
        expect(counts[0]).toEqual({
          operation_count: "1",
          wager_count: "1",
          ledger_count: "1",
        });
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            )
          )?.balance,
        ).toBe(
          Money.fromDecimal("100.00", "BRL")
            .subtract(Money.fromDecimal(acceptedInput.amount, "BRL"))
            .toDecimal(),
        );
        expect(
          await wagers.process(
            context.providerId,
            `external-variant-replay-${randomUUID()}`,
            acceptedInput,
          ),
        ).toEqual({ ...acceptedResult, idempotentReplay: true });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("deduplicates 50 parallel identical wagers and reconciles wallet balance to Ledger", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const metrics = new FinancialMetrics();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
          undefined,
          metrics,
        );

        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `parallel-50-${randomUUID()}`,
          { amount: "10.00" },
        );
        const idempotencyKey = `parallel-50-key-${randomUUID()}`;
        const results = await Promise.all(
          Array.from({ length: 50 }, () =>
            wagers.process(context.providerId, idempotencyKey, input),
          ),
        );

        expect(
          results.every((result) => result.response.status === "PROCESSED"),
        ).toBe(true);
        expect(
          results.every(
            (result) =>
              result.response.transaction?.id ===
              results[0]?.response.transaction?.id,
          ),
        ).toBe(true);
        const persisted =
          await integrationContext.transactionManager.transaction(
            async (session) => ({
              wallet: await session.wallets.findById(context.walletId),
              operation:
                await session.financialOperations.findByExternalTransactionId(
                  context.providerId,
                  input.externalTransactionId,
                ),
              wager:
                await session.wagerTransactions.findByProviderAndExternalTransactionId(
                  context.providerId,
                  input.externalTransactionId,
                ),
            }),
          );
        expect(persisted.wallet?.balance).toBe("90.00");
        expect(persisted.wallet?.version).toBe(3);
        expect(persisted.operation).not.toBeNull();
        expect(persisted.wager).not.toBeNull();
        const ledgerCount = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count
       FROM "${integrationContext.schema}".wallet_ledger_entries
       WHERE wallet_id = ?
         AND wager_transaction_id IN (
           SELECT id FROM "${integrationContext.schema}".wager_transactions WHERE kind <> 'OPENING'
         )`,
          [context.walletId],
        );
        expect(ledgerCount[0]?.count).toBe("1");
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
        const metricOutput = metrics.renderPrometheus();
        expect(metricOutput).toContain(
          'wager_transactions_total{status="PROCESSED"} 1',
        );
        expect(metricOutput).toContain(
          'idempotency_duplicates_total{outcome="replay"} 49',
        );
      });

      test("deduplicates one wager across three independent application processes", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `three-processes-${randomUUID()}`,
          { amount: "15.00" },
        );
        const idempotencyKey = `three-processes-key-${randomUUID()}`;
        const results = await Promise.all(
          Array.from({ length: 3 }, () =>
            integrationContext.runWagerInChildProcess({
              providerId: context.providerId,
              idempotencyKey,
              wager: input,
            }),
          ),
        );

        expect(new Set(results.map((result) => result.pid)).size).toBe(3);
        expect(results.every((result) => result.status === "PROCESSED")).toBe(
          true,
        );
        expect(
          new Set(results.map((result) => result.transactionId)).size,
        ).toBe(1);
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("85.00");
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });
    });
  },
);
