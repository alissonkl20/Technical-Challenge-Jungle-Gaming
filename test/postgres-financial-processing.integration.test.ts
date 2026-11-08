import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  FinancialMetrics,
  IdempotencyConflictError,
  InvalidPayloadError,
  MikroOrmTransactionManager,
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";
import { createWalletWithOpening } from "./support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL financial transaction processing and atomicity",
  (integrationContext) => {
    describe("financial transaction processing and atomicity", () => {
      test("processes wager operations atomically with correct ledger effects", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const bet = await wagers.process(
          context.providerId,
          "bet-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "bet-transaction",
            {
              roundId: "round-1",
            },
          ),
        );
        expect(bet.httpStatus).toBe(200);
        expect(bet.response.status).toBe("PROCESSED");
        expect(bet.response.wallet?.balance).toBe("90.00");

        const win = await wagers.process(
          context.providerId,
          "win-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "win-transaction",
            {
              kind: WagerTransactionKind.WIN,
              amount: "5.00",
              externalReferenceTransactionId: "bet-transaction",
              roundId: "round-1",
            },
          ),
        );
        expect(win.response.wallet?.balance).toBe("95.00");

        // The BET already has its definitive result (the WIN): a REFUND of
        // it is a conflicting result and is refused without moving money.
        const lateRefund = await wagers.process(
          context.providerId,
          "late-refund-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "late-refund-transaction",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "bet-transaction",
              roundId: "round-1",
            },
          ),
        );
        expect(lateRefund.response.status).toBe("REJECTED");
        expect(lateRefund.response.failureCode).toBe(
          "REFERENCE_ALREADY_SETTLED",
        );
        expect(lateRefund.response.wallet?.balance).toBe("95.00");

        const placeBet = (externalId: string) =>
          wagers.process(
            context.providerId,
            `${externalId}-key`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              externalId,
              {
                roundId: "round-1",
              },
            ),
          );
        expect((await placeBet("lost-bet")).response.wallet?.balance).toBe(
          "85.00",
        );
        const loss = await wagers.process(
          context.providerId,
          "loss-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "loss-transaction",
            {
              kind: WagerTransactionKind.LOSS,
              amount: "10.00",
              externalReferenceTransactionId: "lost-bet",
              roundId: "round-1",
            },
          ),
        );
        expect(loss.response.status).toBe("PROCESSED");
        expect(loss.response.wallet?.balance).toBe("85.00");
        const lossLedger =
          await integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.findByTransactionId(
              loss.response.transaction?.id ?? "",
            ),
          );
        expect(lossLedger).toBeNull();
        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.create({
              id: randomUUID(),
              provider_id: context.providerId,
              player_id: context.playerId,
              wallet_id: context.walletId,
              wager_transaction_id: loss.response.transaction?.id ?? "",
              amount: "10.00",
              entry_type: "CREDIT",
              balance_before: "85.00",
              balance_after: "95.00",
            }),
          ),
        ).rejects.toThrow("must not have a Ledger entry");

        expect((await placeBet("refunded-bet")).response.wallet?.balance).toBe(
          "75.00",
        );
        const refund = await wagers.process(
          context.providerId,
          "refund-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "refund-transaction",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "refunded-bet",
              roundId: "round-1",
            },
          ),
        );
        expect(refund.response.wallet?.balance).toBe("85.00");

        const rollback = await wagers.process(
          context.providerId,
          "rollback-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "rollback-transaction",
            {
              kind: WagerTransactionKind.ROLLBACK,
              externalReferenceTransactionId: "refund-transaction",
              roundId: "round-1",
            },
          ),
        );
        expect(rollback.response.wallet?.balance).toBe("75.00");

        const secondRollback = await wagers.process(
          context.providerId,
          "rollback-bet-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "rollback-original-bet",
            {
              kind: WagerTransactionKind.ROLLBACK,
              externalReferenceTransactionId: "refunded-bet",
              roundId: "round-1",
            },
          ),
        );
        expect(secondRollback.response.status).toBe("REJECTED");
        expect(secondRollback.response.failureCode).toBe(
          "REFERENCE_ALREADY_REVERSED",
        );
        expect(secondRollback.response.wallet?.balance).toBe("75.00");

        const ledgerRows = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count FROM "${integrationContext.schema}".wallet_ledger_entries
       WHERE wallet_id = ?
         AND wager_transaction_id IN (
           SELECT id FROM "${integrationContext.schema}".wager_transactions WHERE kind <> 'OPENING'
         )`,
          [context.walletId],
        );
        // bet, win, lost-bet, refunded-bet, refund, rollback. No LOSS entry.
        expect(ledgerRows[0]?.count).toBe("6");
        expect(rollback.response.wallet?.version).toBe(8);
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("persists business rejections and replays idempotent responses", async () => {
        const context = await integrationContext.seedWagerContext("20.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          "rejected-bet",
          {
            amount: "30.00",
          },
        );
        const rejected = await wagers.process(
          context.providerId,
          "reject-key",
          input,
        );
        expect(rejected.httpStatus).toBe(422);
        expect(rejected.response.status).toBe("REJECTED");
        expect(rejected.response.failureCode).toBe("INSUFFICIENT_FUNDS");

        const replay = await wagers.process(
          context.providerId,
          "reject-key",
          input,
        );
        expect(replay).toEqual({ ...rejected, idempotentReplay: true });
        const externalReplay = await wagers.process(
          context.providerId,
          "different-key",
          input,
        );
        expect(externalReplay).toEqual({
          ...rejected,
          idempotentReplay: true,
        });

        await expect(
          wagers.process(
            context.providerId,
            "reject-key",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "different-external-id",
              {
                amount: "30.00",
              },
            ),
          ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
        await expect(
          wagers.process(
            context.providerId,
            "different-key",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "rejected-bet",
              {
                amount: "31.00",
              },
            ),
          ),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      });

      test("rejects externally submitted OPENING transactions", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );

        expect(() =>
          wagers.process(
            context.providerId,
            `external-opening-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `external-opening-tx-${randomUUID()}`,
              {
                kind: WagerTransactionKind.OPENING,
              },
            ),
          ),
        ).toThrow(InvalidPayloadError);
      });

      test("rolls back wager, wallet, ledger, and outbox when SQL fails before commit", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const transactionId = `sql-failure-${randomUUID()}`;
        const triggerName = `fail_outbox_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        await integrationContext.orm.em.execute(
          `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'injected SQL failure before commit';
       END;
       $$`,
        );
        await integrationContext.orm.em.execute(
          `CREATE TRIGGER "${triggerName}"
       BEFORE INSERT ON "${integrationContext.schema}".outbox
       FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
        );

        try {
          await expect(
            new WagerTransactionsService(
              integrationContext.transactionManager,
            ).process(
              context.providerId,
              `sql-failure-key-${randomUUID()}`,
              integrationContext.wagerInput(
                context.externalPlayerId,
                transactionId,
                {
                  amount: "12.00",
                },
              ),
            ),
          ).rejects.toThrow("injected SQL failure before commit");
        } finally {
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".outbox`,
          );
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
        }

        const afterFailure =
          await integrationContext.transactionManager.transaction(
            async (session) => ({
              wallet: await session.wallets.findById(context.walletId),
              operation:
                await session.financialOperations.findByExternalTransactionId(
                  context.providerId,
                  transactionId,
                ),
              wager:
                await session.wagerTransactions.findByProviderAndExternalTransactionId(
                  context.providerId,
                  transactionId,
                ),
            }),
          );
        expect(afterFailure.wallet?.balance).toBe("100.00");
        expect(afterFailure.wallet?.version).toBe(2);
        expect(afterFailure.operation).toBeNull();
        expect(afterFailure.wager).toBeNull();
        const entries = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count FROM "${integrationContext.schema}".wallet_ledger_entries
       WHERE wallet_id = ?
         AND wager_transaction_id IN (
           SELECT id FROM "${integrationContext.schema}".wager_transactions WHERE kind <> 'OPENING'
         )`,
          [context.walletId],
        );
        expect(entries[0]?.count).toBe("0");
      });

      test("rolls back the wallet update when Ledger insertion fails inside the transaction", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const externalTransactionId = `ledger-insert-failure-${randomUUID()}`;
        const idempotencyKey = `ledger-insert-failure-key-${randomUUID()}`;
        const triggerName = `fail_ledger_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        await integrationContext.orm.em.execute(
          `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'injected failure before Ledger insert'
           USING ERRCODE = '55000';
       END;
       $$`,
        );
        await integrationContext.orm.em.execute(
          `CREATE TRIGGER "${triggerName}"
       BEFORE INSERT ON "${integrationContext.schema}".wallet_ledger_entries
       FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
        );

        try {
          await expect(
            new WagerTransactionsService(
              integrationContext.transactionManager,
            ).process(
              context.providerId,
              idempotencyKey,
              integrationContext.wagerInput(
                context.externalPlayerId,
                externalTransactionId,
                {
                  amount: "12.00",
                },
              ),
            ),
          ).rejects.toThrow("injected failure before Ledger insert");
        } finally {
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".wallet_ledger_entries`,
          );
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
        }

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
            outbox_count: string;
            balance: string;
            version: number;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND idempotency_key = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries ledger
          JOIN "${integrationContext.schema}".wager_transactions wager
            ON wager.id = ledger.wager_transaction_id
          WHERE wager.provider_id = ? AND wager.external_transaction_id = ?)
           AS ledger_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
          WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') IN (
            SELECT id::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )
             OR payload->'data'->>'financialOperationId' IN (
            SELECT id::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS outbox_count,
         wallet.balance::text AS balance,
         wallet.version
       FROM "${integrationContext.schema}".wallets wallet
       WHERE wallet.id = ?`,
          [
            context.providerId,
            idempotencyKey,
            context.providerId,
            externalTransactionId,
            context.providerId,
            externalTransactionId,
            context.providerId,
            externalTransactionId,
            context.providerId,
            externalTransactionId,
            context.walletId,
          ],
        );
        expect(persisted[0]).toEqual({
          operation_count: "0",
          wager_count: "0",
          ledger_count: "0",
          outbox_count: "0",
          balance: "100.00",
          version: 2,
        });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("retries a transient PostgreSQL serialization failure without duplicate financial effects", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const transactionId = `serialization-retry-${randomUUID()}`;
        const triggerName = `retry_operation_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        const sequenceName = `${triggerName}_sequence`;
        await integrationContext.orm.em.execute(
          `CREATE SEQUENCE "${integrationContext.schema}"."${sequenceName}" START WITH 1`,
        );
        await integrationContext.orm.em.execute(
          `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF nextval('"${integrationContext.schema}"."${sequenceName}"'::regclass) = 1 THEN
           RAISE EXCEPTION 'injected transient serialization failure'
             USING ERRCODE = '40001';
         END IF;
         RETURN NEW;
       END;
       $$`,
        );
        await integrationContext.orm.em.execute(
          `CREATE TRIGGER "${triggerName}"
       BEFORE INSERT ON "${integrationContext.schema}".financial_operations
       FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
        );
        const metrics = new FinancialMetrics();
        const retryingTransactions = new MikroOrmTransactionManager(
          integrationContext.orm.em,
          3,
          metrics,
        );

        try {
          const result = await new WagerTransactionsService(
            retryingTransactions,
          ).process(
            context.providerId,
            `serialization-key-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              transactionId,
              {
                amount: "12.00",
              },
            ),
          );
          expect(result.httpStatus).toBe(200);
          expect(result.response.status).toBe("PROCESSED");
          expect(result.response.wallet?.balance).toBe("88.00");
          expect(metrics.renderPrometheus()).toContain(
            'financial_retries_total{component="database"} 1',
          );
          const sequence = await integrationContext.orm.em.execute<
            { last_value: string }[]
          >(
            `SELECT last_value::text FROM "${integrationContext.schema}"."${sequenceName}"`,
          );
          expect(sequence[0]?.last_value).toBe("2");
        } finally {
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".financial_operations`,
          );
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          await integrationContext.orm.em.execute(
            `DROP SEQUENCE "${integrationContext.schema}"."${sequenceName}"`,
          );
        }

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
            outbox_count: string;
            balance: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND amount = '12.00') AS ledger_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
          WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') IN (
            SELECT id::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS outbox_count,
         (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance`,
          [
            context.providerId,
            transactionId,
            context.providerId,
            transactionId,
            context.walletId,
            context.providerId,
            transactionId,
            context.walletId,
          ],
        );
        expect(persisted[0]).toEqual({
          operation_count: "1",
          wager_count: "1",
          ledger_count: "1",
          outbox_count: "2",
          balance: "88.00",
        });
      });

      test("stops PostgreSQL serialization retries at the limit and rolls back every financial write", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const transactionId = `serialization-exhausted-${randomUUID()}`;
        const triggerName = `fail_operation_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        const sequenceName = `${triggerName}_sequence`;
        await integrationContext.orm.em.execute(
          `CREATE SEQUENCE "${integrationContext.schema}"."${sequenceName}" START WITH 1`,
        );
        await integrationContext.orm.em.execute(
          `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         PERFORM nextval('"${integrationContext.schema}"."${sequenceName}"'::regclass);
         RAISE EXCEPTION 'injected persistent serialization failure'
           USING ERRCODE = '40001';
       END;
       $$`,
        );
        await integrationContext.orm.em.execute(
          `CREATE TRIGGER "${triggerName}"
       BEFORE INSERT ON "${integrationContext.schema}".financial_operations
       FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
        );
        const maxRetries = 2;
        const metrics = new FinancialMetrics();
        const retryingTransactions = new MikroOrmTransactionManager(
          integrationContext.orm.em,
          maxRetries,
          metrics,
        );

        try {
          await expect(
            new WagerTransactionsService(retryingTransactions).process(
              context.providerId,
              `serialization-exhausted-key-${randomUUID()}`,
              integrationContext.wagerInput(
                context.externalPlayerId,
                transactionId,
                {
                  amount: "12.00",
                },
              ),
            ),
          ).rejects.toThrow("injected persistent serialization failure");
          expect(metrics.renderPrometheus()).toContain(
            `financial_retries_total{component="database"} ${maxRetries}`,
          );
          const attempts = await integrationContext.orm.em.execute<
            { last_value: string }[]
          >(
            `SELECT last_value::text FROM "${integrationContext.schema}"."${sequenceName}"`,
          );
          expect(attempts[0]?.last_value).toBe(String(maxRetries + 1));
        } finally {
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".financial_operations`,
          );
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          await integrationContext.orm.em.execute(
            `DROP SEQUENCE "${integrationContext.schema}"."${sequenceName}"`,
          );
        }

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            ledger_count: string;
            outbox_count: string;
            balance: string;
            version: number;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id = ?) AS operation_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
          WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
          WHERE wallet_id = ? AND amount = '12.00') AS ledger_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
          WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') IN (
            SELECT id::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?
          )) AS outbox_count,
         balance::text AS balance,
         version
       FROM "${integrationContext.schema}".wallets WHERE id = ?`,
          [
            context.providerId,
            transactionId,
            context.providerId,
            transactionId,
            context.walletId,
            context.providerId,
            transactionId,
            context.walletId,
          ],
        );
        expect(persisted[0]).toEqual({
          operation_count: "0",
          wager_count: "0",
          ledger_count: "0",
          outbox_count: "0",
          balance: "100.00",
          version: 2,
        });
      });

      test("rejects reversals with mismatched amount, round, kind, or wallet context", async () => {
        const context = await integrationContext.seedWagerContext();
        const otherPlayerId = randomUUID();
        const otherCurrencyWalletId = randomUUID();
        await integrationContext.transactionManager.transaction(
          async (session) => {
            await createWalletWithOpening(session, {
              id: otherCurrencyWalletId,
              provider_id: context.providerId,
              player_id: context.playerId,
              currency: "USD",
              balance: "100.00",
              version: 1,
            });
            await session.players.create({
              id: otherPlayerId,
              provider_id: context.providerId,
              external_player_id: `other-${randomUUID()}`,
              status: "ACTIVE",
            });
            await createWalletWithOpening(session, {
              id: randomUUID(),
              provider_id: context.providerId,
              player_id: otherPlayerId,
              currency: "BRL",
              balance: "100.00",
              version: 1,
            });
          },
        );
        const otherPlayer =
          await integrationContext.transactionManager.transaction((session) =>
            session.players.findById(otherPlayerId),
          );
        if (otherPlayer === null) {
          throw new Error("Seeded second player was not persisted");
        }

        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        await wagers.process(
          context.providerId,
          "reversal-target-bet",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "reversal-target",
            {
              roundId: "round-a",
            },
          ),
        );
        const wrongAmount = await wagers.process(
          context.providerId,
          "wrong-amount-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "wrong-amount-refund",
            {
              kind: WagerTransactionKind.REFUND,
              amount: "9.00",
              externalReferenceTransactionId: "reversal-target",
              roundId: "round-a",
            },
          ),
        );
        expect(wrongAmount.response.failureCode).toBe(
          "REFERENCE_AMOUNT_MISMATCH",
        );

        const wrongRound = await wagers.process(
          context.providerId,
          "wrong-round-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "wrong-round-refund",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "reversal-target",
              roundId: "round-b",
            },
          ),
        );
        expect(wrongRound.response.failureCode).toBe(
          "REFERENCE_ROUND_MISMATCH",
        );

        const otherWallet = await wagers.process(
          context.providerId,
          "wrong-wallet-key",
          integrationContext.wagerInput(
            otherPlayer.external_player_id,
            "wrong-wallet-refund",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "reversal-target",
              roundId: "round-a",
            },
          ),
        );
        expect(otherWallet.response.failureCode).toBe(
          "REFERENCE_CONTEXT_MISMATCH",
        );
        const wrongCurrency = await wagers.process(
          context.providerId,
          "wrong-currency-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "wrong-currency-refund",
            {
              kind: WagerTransactionKind.REFUND,
              currency: "USD",
              externalReferenceTransactionId: "reversal-target",
              roundId: "round-a",
            },
          ),
        );
        expect(wrongCurrency.response.failureCode).toBe(
          "REFERENCE_CONTEXT_MISMATCH",
        );

        await wagers.process(
          context.providerId,
          "loss-bet-key",
          integrationContext.wagerInput(context.externalPlayerId, "loss-bet", {
            amount: "1.00",
          }),
        );
        await wagers.process(
          context.providerId,
          "loss-reference-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "loss-reference-target",
            {
              kind: WagerTransactionKind.LOSS,
              externalReferenceTransactionId: "loss-bet",
            },
          ),
        );
        const ineligible = await wagers.process(
          context.providerId,
          "ineligible-refund-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "ineligible-refund",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "loss-reference-target",
            },
          ),
        );
        expect(ineligible.response.failureCode).toBe(
          "REFERENCE_KIND_NOT_ELIGIBLE",
        );
      });

      test("rejects wallet balance changes that do not include a matching Ledger entry", async () => {
        const context = await integrationContext.seedWagerContext("15.00");
        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.updateBalance(context.walletId, 2, "14.00"),
          ),
        ).rejects.toThrow(
          "wallet balance changes require a matching Ledger entry",
        );

        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("15.00");
        expect(wallet?.version).toBe(2);
      });
    });
  },
);
