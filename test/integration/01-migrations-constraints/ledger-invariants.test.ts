import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import { randomUUID } from "../../support/postgres-test-dependencies.js";
import { createWalletWithOpening } from "../../support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL ledger immutability and reversal constraints",
  (integrationContext) => {
    describe("ledger immutability and reversal constraints", () => {
      test("enforces ledger immutability and one processed reversal per target", async () => {
        const providerId = randomUUID();
        const playerId = randomUUID();
        const walletId = randomUUID();
        const originalWagerId = randomUUID();
        const reversalTarget = randomUUID();
        const operationIds: [string, string, string] = [
          randomUUID(),
          randomUUID(),
          randomUUID(),
        ];
        const originalOperationId = operationIds[0];

        await integrationContext.transactionManager.transaction(
          async (session) => {
            await session.providers.create({
              id: providerId,
              code: "reversal-provider",
              name: "Reversal Provider",
              status: "ACTIVE",
            });
            await session.players.create({
              id: playerId,
              provider_id: providerId,
              external_player_id: "reversal-player",
              status: "ACTIVE",
            });
            await createWalletWithOpening(session, {
              id: walletId,
              provider_id: providerId,
              player_id: playerId,
              currency: "BRL",
              balance: "100.00",
              version: 1,
            });
            for (const [index, id] of operationIds.entries()) {
              await session.financialOperations.create({
                id,
                provider_id: providerId,
                idempotency_key: `reversal-key-${index}`,
                external_transaction_id: `reversal-external-${index}`,
                payload_hash: `${index}`.repeat(64),
                response_snapshot: {},
                response_http_status: 200,
                completed_at: new Date(),
              });
            }
            await session.wagerTransactions.create({
              id: originalWagerId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: originalOperationId,
              external_transaction_id: "original-wager",
              external_reference_transaction_id: null,
              reference_transaction_id: null,
              round_id: null,
              game_id: null,
              kind: "BET",
              status: "PROCESSED",
              amount: "10.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });

            await session.wallets.updateBalance(walletId, 1, "90.00");
            await session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: originalWagerId,
              amount: "10.00",
              entry_type: "DEBIT",
              balance_before: "100.00",
              balance_after: "90.00",
            });
            expect(
              (await session.walletLedger.findByTransactionId(originalWagerId))
                ?.id,
            ).toBeDefined();
          },
        );

        const immutableLedgerUpdates: Array<{
          readonly field: string;
          readonly value: string;
        }> = [
          { field: "id", value: randomUUID() },
          { field: "amount", value: "11.00" },
          { field: "entry_type", value: "CREDIT" },
          { field: "balance_before", value: "101.00" },
          { field: "balance_after", value: "91.00" },
          { field: "wallet_id", value: randomUUID() },
          { field: "player_id", value: randomUUID() },
          { field: "provider_id", value: randomUUID() },
          { field: "wager_transaction_id", value: randomUUID() },
          { field: "created_at", value: "2000-01-01T00:00:00Z" },
        ];
        for (const { field, value } of immutableLedgerUpdates) {
          await expect(
            integrationContext.orm.em.execute(
              `UPDATE "${integrationContext.schema}"."wallet_ledger_entries"
           SET "${field}" = ? WHERE wager_transaction_id = ?`,
              [value, originalWagerId],
            ),
          ).rejects.toThrow();
        }
        await expect(
          integrationContext.orm.em.execute(
            `DELETE FROM "${integrationContext.schema}"."wallet_ledger_entries"
         WHERE wager_transaction_id = ?`,
            [originalWagerId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `TRUNCATE TABLE "${integrationContext.schema}"."wallet_ledger_entries"`,
          ),
        ).rejects.toThrow();
        const immutableWagerUpdates: Array<{
          readonly field: string;
          readonly value: string;
        }> = [
          { field: "id", value: randomUUID() },
          { field: "provider_id", value: randomUUID() },
          { field: "player_id", value: randomUUID() },
          { field: "wallet_id", value: randomUUID() },
          { field: "financial_operation_id", value: randomUUID() },
          { field: "external_transaction_id", value: "rewritten-external-id" },
          {
            field: "external_reference_transaction_id",
            value: "rewritten-reference",
          },
          { field: "reference_transaction_id", value: randomUUID() },
          { field: "round_id", value: "rewritten-round" },
          { field: "game_id", value: "rewritten-game" },
          { field: "kind", value: "WIN" },
          { field: "status", value: "REJECTED" },
          { field: "amount", value: "11.00" },
          { field: "currency", value: "USD" },
          { field: "failure_code", value: "REWRITTEN" },
          { field: "reference_attempts", value: "1" },
          {
            field: "next_reference_attempt_at",
            value: "2025-01-01T00:00:00Z",
          },
          { field: "reference_expires_at", value: "2025-02-01T00:00:00Z" },
          { field: "created_at", value: "2000-01-01T00:00:00Z" },
          { field: "processed_at", value: "2000-01-01T00:00:00Z" },
          { field: "completed_at", value: "2000-01-01T00:00:00Z" },
        ];
        for (const { field, value } of immutableWagerUpdates) {
          await expect(
            integrationContext.orm.em.execute(
              `UPDATE "${integrationContext.schema}"."wager_transactions"
           SET "${field}" = ? WHERE id = ?`,
              [value, originalWagerId],
            ),
          ).rejects.toThrow();
        }
        await expect(
          integrationContext.orm.em.execute(
            `DELETE FROM "${integrationContext.schema}"."wager_transactions" WHERE id = ?`,
            [originalWagerId],
          ),
        ).rejects.toThrow();
        const immutableOperationUpdates: Array<{
          readonly field: string;
          readonly value: string;
        }> = [
          { field: "id", value: randomUUID() },
          { field: "provider_id", value: randomUUID() },
          { field: "idempotency_key", value: "rewritten-idempotency-key" },
          {
            field: "external_transaction_id",
            value: "rewritten-external-transaction",
          },
          { field: "payload_hash", value: "a".repeat(64) },
          {
            field: "response_snapshot",
            value: '{"status":"REJECTED"}',
          },
          { field: "response_http_status", value: "201" },
          { field: "created_at", value: "2000-01-01T00:00:00Z" },
          { field: "completed_at", value: "2025-01-01T00:00:00Z" },
        ];
        for (const { field, value } of immutableOperationUpdates) {
          await expect(
            integrationContext.orm.em.execute(
              `UPDATE "${integrationContext.schema}"."financial_operations"
           SET "${field}" = ${field === "response_snapshot" ? "?::jsonb" : "?"}
           WHERE id = ?`,
              [value, originalOperationId],
            ),
          ).rejects.toThrow();
        }
        await expect(
          integrationContext.orm.em.execute(
            `DELETE FROM "${integrationContext.schema}"."financial_operations" WHERE id = ?`,
            [originalOperationId],
          ),
        ).rejects.toThrow();
        const immutableRecords = await integrationContext.orm.em.execute<
          {
            wager_id: string;
            wager_status: string;
            wager_external_transaction_id: string;
            wager_external_reference_transaction_id: string | null;
            wager_amount: string;
            operation_id: string;
            idempotency_key: string;
            external_transaction_id: string;
            payload_hash: string;
            response_snapshot: unknown;
            ledger_amount: string;
            ledger_entry_type: string;
            balance_before: string;
            balance_after: string;
          }[]
        >(
          `SELECT
         wager.id AS wager_id,
         wager.status AS wager_status,
         wager.external_transaction_id AS wager_external_transaction_id,
         wager.external_reference_transaction_id
           AS wager_external_reference_transaction_id,
         wager.amount::text AS wager_amount,
         operation.id AS operation_id,
         operation.idempotency_key,
         operation.external_transaction_id,
         operation.payload_hash,
         operation.response_snapshot,
         ledger.amount::text AS ledger_amount,
         ledger.entry_type AS ledger_entry_type,
         ledger.balance_before::text AS balance_before,
         ledger.balance_after::text AS balance_after
       FROM "${integrationContext.schema}".wager_transactions wager
       JOIN "${integrationContext.schema}".financial_operations operation
         ON operation.id = wager.financial_operation_id
       JOIN "${integrationContext.schema}".wallet_ledger_entries ledger
         ON ledger.wager_transaction_id = wager.id
       WHERE wager.id = ?`,
          [originalWagerId],
        );
        expect(immutableRecords[0]).toEqual({
          wager_id: originalWagerId,
          wager_status: "PROCESSED",
          wager_external_transaction_id: "original-wager",
          wager_external_reference_transaction_id: null,
          wager_amount: "10.00",
          operation_id: originalOperationId,
          idempotency_key: "reversal-key-0",
          external_transaction_id: "reversal-external-0",
          payload_hash: "0".repeat(64),
          response_snapshot: {},
          ledger_amount: "10.00",
          ledger_entry_type: "DEBIT",
          balance_before: "100.00",
          balance_after: "90.00",
        });
        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: originalWagerId,
              amount: "10.00",
              entry_type: "CREDIT",
              balance_before: "90.00",
              balance_after: "100.00",
            }),
          ),
        ).rejects.toThrow("does not match its processed transaction");
        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: originalWagerId,
              amount: "9.00",
              entry_type: "DEBIT",
              balance_before: "100.00",
              balance_after: "91.00",
            }),
          ),
        ).rejects.toThrow("does not match its processed transaction");

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            await session.wallets.updateBalance(walletId, 2, "80.00");
            await session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: originalWagerId,
              amount: "10.00",
              entry_type: "DEBIT",
              balance_before: "90.00",
              balance_after: "80.00",
            });
          }),
        ).rejects.toThrow();

        const createReversal = (
          index: 1 | 2,
          status: "PROCESSED" | "PENDING",
        ): Promise<void> => {
          const operationId = operationIds[index];
          const reversalId = index === 1 ? reversalTarget : randomUUID();
          const balanceBefore = index === 1 ? "90.00" : "100.00";
          const balanceAfter = index === 1 ? "100.00" : "110.00";
          const expectedVersion = index === 1 ? 2 : 3;
          return integrationContext.transactionManager.transaction(
            async (session) => {
              await session.wagerTransactions.create({
                id: reversalId,
                provider_id: providerId,
                player_id: playerId,
                wallet_id: walletId,
                financial_operation_id: operationId,
                external_transaction_id: `reversal-${index}`,
                external_reference_transaction_id: "original-wager",
                reference_transaction_id: originalWagerId,
                round_id: null,
                game_id: null,
                kind: "REFUND",
                status,
                amount: "10.00",
                currency: "BRL",
                failure_code: null,
                reference_attempts: 0,
                next_reference_attempt_at: null,
                reference_expires_at: null,
                processed_at: status === "PROCESSED" ? new Date() : null,
                completed_at: status === "PROCESSED" ? new Date() : null,
              });
              if (status === "PROCESSED") {
                const updated = await session.wallets.updateBalance(
                  walletId,
                  expectedVersion,
                  balanceAfter,
                );
                if (updated === null) {
                  throw new Error("Could not apply the test reversal balance");
                }
                await session.walletLedger.create({
                  id: randomUUID(),
                  provider_id: providerId,
                  player_id: playerId,
                  wallet_id: walletId,
                  wager_transaction_id: reversalId,
                  amount: "10.00",
                  entry_type: "CREDIT",
                  balance_before: balanceBefore,
                  balance_after: balanceAfter,
                });
              }
            },
          );
        };

        await createReversal(1, "PROCESSED");
        const reversalIndex = await integrationContext.orm.em.execute<
          { indexdef: string }[]
        >(
          `SELECT indexdef FROM pg_indexes
       WHERE schemaname = ? AND indexname = 'uq_successful_reversal_per_target'`,
          [integrationContext.schema],
        );
        expect(reversalIndex).toHaveLength(1);
        expect(reversalIndex[0]?.indexdef).toContain("WHERE");
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wager_transactions
          (id, provider_id, player_id, wallet_id, financial_operation_id,
           external_transaction_id, external_reference_transaction_id,
           reference_transaction_id, kind, status, amount, currency,
           processed_at, completed_at)
         VALUES (?, ?, ?, ?, ?, 'direct-duplicate-refund',
           'original-wager', ?, 'REFUND', 'PROCESSED', '10.00', 'BRL',
           now(), now())`,
            [
              randomUUID(),
              providerId,
              playerId,
              walletId,
              operationIds[2],
              originalWagerId,
            ],
          ),
        ).rejects.toThrow();
        // A REFUND is also the result of its BET. Even unprocessed, a second
        // one would reserve a result the BET already has, so PostgreSQL
        // refuses it.
        await expect(createReversal(2, "PENDING")).rejects.toThrow(
          "BET already has an active result",
        );
      });

      test("keeps refund and rollback semantics explicit and mutually exclusive on the same original wager", async () => {
        const providerId = randomUUID();
        const playerId = randomUUID();
        const walletId = randomUUID();
        const originalBetId = randomUUID();
        const refundId = randomUUID();
        const rollbackOfRefundId = randomUUID();
        const rollbackId = randomUUID();

        const persistProcessedReversal = async ({
          financialOperationId,
          id,
          externalTransactionId,
          externalReferenceTransactionId,
          referenceTransactionId,
          kind,
          amount,
          balanceAfter,
          ledgerEntryType,
          expectedWalletVersion,
          balanceBefore,
        }: {
          readonly financialOperationId: string;
          readonly id: string;
          readonly externalTransactionId: string;
          readonly externalReferenceTransactionId: string;
          readonly referenceTransactionId: string;
          readonly kind: "REFUND" | "ROLLBACK";
          readonly amount: string;
          readonly balanceAfter: string;
          readonly ledgerEntryType: "CREDIT" | "DEBIT";
          readonly expectedWalletVersion: number;
          readonly balanceBefore: string;
        }) => {
          await integrationContext.transactionManager.transaction(
            async (session) => {
              await session.financialOperations.create({
                id: financialOperationId,
                provider_id: providerId,
                idempotency_key: externalTransactionId,
                external_transaction_id: externalTransactionId,
                payload_hash: "f".repeat(64),
                response_snapshot: {},
                response_http_status: 200,
                completed_at: new Date(Date.now() + 1_000),
              });
              await session.wagerTransactions.create({
                id,
                provider_id: providerId,
                player_id: playerId,
                wallet_id: walletId,
                financial_operation_id: financialOperationId,
                external_transaction_id: externalTransactionId,
                external_reference_transaction_id:
                  externalReferenceTransactionId,
                reference_transaction_id: referenceTransactionId,
                round_id: null,
                game_id: null,
                kind,
                status: "PROCESSED",
                amount,
                currency: "BRL",
                failure_code: null,
                reference_attempts: 0,
                next_reference_attempt_at: null,
                reference_expires_at: null,
                processed_at: new Date(),
                completed_at: new Date(),
              });
              const updatedWallet = await session.wallets.updateBalance(
                walletId,
                expectedWalletVersion,
                balanceAfter,
              );
              if (updatedWallet === null) {
                throw new Error(
                  "Could not persist wallet update for reversal test",
                );
              }
              await session.walletLedger.create({
                id: randomUUID(),
                provider_id: providerId,
                player_id: playerId,
                wallet_id: walletId,
                wager_transaction_id: id,
                amount,
                entry_type: ledgerEntryType,
                balance_before: balanceBefore,
                balance_after: balanceAfter,
              });
            },
          );
        };

        await integrationContext.transactionManager.transaction(
          async (session) => {
            await session.providers.create({
              id: providerId,
              code: `reversal-policy-${randomUUID()}`,
              name: "Reversal Policy Provider",
              status: "ACTIVE",
            });
            await session.players.create({
              id: playerId,
              provider_id: providerId,
              external_player_id: "reversal-policy-player",
              status: "ACTIVE",
            });
            await createWalletWithOpening(session, {
              id: walletId,
              provider_id: providerId,
              player_id: playerId,
              currency: "BRL",
              balance: "100.00",
              version: 1,
            });
            const originalBetOperationId = randomUUID();
            await session.financialOperations.create({
              id: originalBetOperationId,
              provider_id: providerId,
              idempotency_key: "original-policy-wager",
              external_transaction_id: "original-policy-wager",
              payload_hash: "9".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: new Date(Date.now() + 1_000),
            });
            await session.wagerTransactions.create({
              id: originalBetId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: originalBetOperationId,
              external_transaction_id: "original-policy-wager",
              external_reference_transaction_id: null,
              reference_transaction_id: null,
              round_id: null,
              game_id: null,
              kind: "BET",
              status: "PROCESSED",
              amount: "10.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
            await session.wallets.updateBalance(walletId, 1, "90.00");
            await session.walletLedger.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: originalBetId,
              amount: "10.00",
              entry_type: "DEBIT",
              balance_before: "100.00",
              balance_after: "90.00",
            });
          },
        );

        await persistProcessedReversal({
          financialOperationId: randomUUID(),
          id: refundId,
          externalTransactionId: "refund-policy",
          externalReferenceTransactionId: "original-policy-wager",
          referenceTransactionId: originalBetId,
          kind: "REFUND",
          amount: "10.00",
          balanceAfter: "100.00",
          ledgerEntryType: "CREDIT",
          expectedWalletVersion: 2,
          balanceBefore: "90.00",
        });

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            const duplicateRefundOperationId = randomUUID();
            await session.financialOperations.create({
              id: duplicateRefundOperationId,
              provider_id: providerId,
              idempotency_key: "second-refund-policy",
              external_transaction_id: "second-refund-policy",
              payload_hash: "a".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: new Date(Date.now() + 1_000),
            });
            await session.wagerTransactions.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: duplicateRefundOperationId,
              external_transaction_id: "second-refund-policy",
              external_reference_transaction_id: "original-policy-wager",
              reference_transaction_id: originalBetId,
              round_id: null,
              game_id: null,
              kind: "REFUND",
              status: "PROCESSED",
              amount: "10.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
          }),
        ).rejects.toThrow(
          // A second REFUND is both a second reversal and a second result of
          // the BET; whichever trigger fires first refuses it.
          /already has a processed reversal|already has an active result/,
        );

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            const rollbackOperationId = randomUUID();
            await session.financialOperations.create({
              id: rollbackOperationId,
              provider_id: providerId,
              idempotency_key: "rollback-dangerous-policy",
              external_transaction_id: "rollback-dangerous-policy",
              payload_hash: "a".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: new Date(Date.now() + 1_000),
            });
            await session.wagerTransactions.create({
              id: rollbackId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: rollbackOperationId,
              external_transaction_id: "rollback-dangerous-policy",
              external_reference_transaction_id: "original-policy-wager",
              reference_transaction_id: originalBetId,
              round_id: null,
              game_id: null,
              kind: "ROLLBACK",
              status: "PROCESSED",
              amount: "10.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
          }),
        ).rejects.toThrow("already has a processed reversal");

        await persistProcessedReversal({
          financialOperationId: randomUUID(),
          id: rollbackOfRefundId,
          externalTransactionId: "rollback-refund-policy",
          externalReferenceTransactionId: "refund-policy",
          referenceTransactionId: refundId,
          kind: "ROLLBACK",
          amount: "10.00",
          balanceAfter: "90.00",
          ledgerEntryType: "DEBIT",
          expectedWalletVersion: 3,
          balanceBefore: "100.00",
        });

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            const duplicateRollbackOperationId = randomUUID();
            await session.financialOperations.create({
              id: duplicateRollbackOperationId,
              provider_id: providerId,
              idempotency_key: "duplicate-rollback-refund-policy",
              external_transaction_id: "duplicate-rollback-refund-policy",
              payload_hash: "a".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: new Date(Date.now() + 1_000),
            });
            await session.wagerTransactions.create({
              id: randomUUID(),
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: duplicateRollbackOperationId,
              external_transaction_id: "duplicate-rollback-refund-policy",
              external_reference_transaction_id: "refund-policy",
              reference_transaction_id: refundId,
              round_id: null,
              game_id: null,
              kind: "ROLLBACK",
              status: "PROCESSED",
              amount: "10.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
          }),
        ).rejects.toThrow("already has a processed reversal");
      });
    });
  },
);
