import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL refund and rollback rules",
  (integrationContext) => {
    describe("refund and rollback rules", () => {
      test("allows only one successful refund for a bet under concurrent requests", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        await wagers.process(
          context.providerId,
          "original-bet-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "original-bet",
          ),
        );

        const refunds = await Promise.all([
          wagers.process(
            context.providerId,
            "refund-key-one",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "refund-one",
              {
                kind: WagerTransactionKind.REFUND,
                externalReferenceTransactionId: "original-bet",
              },
            ),
          ),
          wagers.process(
            context.providerId,
            "refund-key-two",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "refund-two",
              {
                kind: WagerTransactionKind.REFUND,
                externalReferenceTransactionId: "original-bet",
              },
            ),
          ),
        ]);

        expect(refunds.map((item) => item.response.status).sort()).toEqual([
          "PROCESSED",
          "REJECTED",
        ]);
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("100.00");
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
        expect(ledgerRows[0]?.count).toBe("2");
      });

      test("allows only one successful rollback for a transaction under concurrent requests", async () => {
        const context = await integrationContext.seedWagerContext("1.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const stakeId = `rollback-stake-${randomUUID()}`;
        await wagers.process(
          context.providerId,
          `${stakeId}-key`,
          integrationContext.wagerInput(context.externalPlayerId, stakeId, {
            amount: "1.00",
          }),
        );
        await wagers.process(
          context.providerId,
          `rollback-source-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `rollback-source-${randomUUID()}`,
            {
              kind: WagerTransactionKind.WIN,
              amount: "20.00",
              externalReferenceTransactionId: stakeId,
            },
          ),
        );
        const source = await integrationContext.transactionManager.transaction(
          (session) =>
            session.wagerTransactions.findAllByProviderAndPlayer(
              context.providerId,
              context.playerId,
              10,
              0,
            ),
        );
        const sourceTransaction = source.find((item) => item.kind === "WIN");
        if (
          sourceTransaction?.external_transaction_id === null ||
          sourceTransaction === undefined
        ) {
          throw new Error("Credit source was not persisted");
        }

        const outcomes = await Promise.all([
          wagers.process(
            context.providerId,
            `rollback-key-one-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `rollback-one-${randomUUID()}`,
              {
                kind: WagerTransactionKind.ROLLBACK,
                amount: "20.00",
                externalReferenceTransactionId:
                  sourceTransaction.external_transaction_id,
              },
            ),
          ),
          wagers.process(
            context.providerId,
            `rollback-key-two-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `rollback-two-${randomUUID()}`,
              {
                kind: WagerTransactionKind.ROLLBACK,
                amount: "20.00",
                externalReferenceTransactionId:
                  sourceTransaction.external_transaction_id,
              },
            ),
          ),
        ]);

        expect(outcomes.map((item) => item.response.status).sort()).toEqual([
          "PROCESSED",
          "REJECTED",
        ]);
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            )
          )?.balance,
        ).toBe("0.00");
      });

      test("rejects a rollback that would overdraw the wallet", async () => {
        const context = await integrationContext.seedWagerContext("1.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        await wagers.process(
          context.providerId,
          "credit-stake-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "credit-stake",
            {
              amount: "1.00",
            },
          ),
        );
        await wagers.process(
          context.providerId,
          "credit-source-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "credit-source",
            {
              kind: WagerTransactionKind.WIN,
              amount: "10.00",
              externalReferenceTransactionId: "credit-stake",
            },
          ),
        );
        await wagers.process(
          context.providerId,
          "spend-credit-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "spend-credit",
            {
              amount: "10.00",
            },
          ),
        );
        const rollback = await wagers.process(
          context.providerId,
          "overdraw-rollback-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "overdraw-rollback",
            {
              kind: WagerTransactionKind.ROLLBACK,
              amount: "10.00",
              externalReferenceTransactionId: "credit-source",
            },
          ),
        );

        expect(rollback.response.status).toBe("REJECTED");
        // A reversal that would overdraw the wallet carries a code distinct
        // from a bet placed without funds.
        expect(rollback.response.failureCode).toBe(
          "REVERSAL_INSUFFICIENT_FUNDS",
        );
        expect(rollback.response.wallet?.balance).toBe("0.00");
        const rollbackLedger =
          await integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.findByTransactionId(
              rollback.response.transaction?.id ?? "",
            ),
          );
        expect(rollbackLedger).toBeNull();
      });
    });
  },
);
