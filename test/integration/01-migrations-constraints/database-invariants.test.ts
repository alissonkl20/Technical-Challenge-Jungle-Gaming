import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  randomUUID,
  WagerTransaction,
} from "../../support/postgres-test-dependencies.js";
import { createWalletWithOpening } from "../../support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL database constraints and idempotency",
  (integrationContext) => {
    describe("database constraints and idempotency", () => {
      test("rejects direct SQL violations of financial schema constraints", async () => {
        const first = await integrationContext.seedWagerContext("10.00");
        const second = await integrationContext.seedWagerContext("0.00");
        const operationIds = {
          first: randomUUID(),
          duplicateIdempotency: randomUUID(),
          duplicateExternalId: randomUUID(),
          crossProvider: randomUUID(),
          pendingWager: randomUUID(),
          pendingWagerDuplicateOperation: randomUUID(),
          secondProviderWager: randomUUID(),
          crossProviderReference: randomUUID(),
        };
        const operation = async (
          id: string,
          providerId: string,
          idempotencyKey: string,
          externalTransactionId: string,
        ): Promise<void> => {
          await integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".financial_operations
          (id, provider_id, idempotency_key, external_transaction_id,
           payload_hash, response_snapshot, response_http_status)
         VALUES (?, ?, ?, ?, ?, '{}'::jsonb, 202)`,
            [
              id,
              providerId,
              idempotencyKey,
              externalTransactionId,
              "a".repeat(64),
            ],
          );
        };
        const pendingWager = async (
          id: string,
          providerId: string,
          playerId: string,
          walletId: string,
          financialOperationId: string,
          externalTransactionId: string,
          referenceTransactionId: string | null = null,
        ): Promise<void> => {
          await integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wager_transactions
          (id, provider_id, player_id, wallet_id, financial_operation_id,
           external_transaction_id, reference_transaction_id, kind, status,
           amount, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'BET', 'PENDING', '1.00', 'BRL')`,
            [
              id,
              providerId,
              playerId,
              walletId,
              financialOperationId,
              externalTransactionId,
              referenceTransactionId,
            ],
          );
        };

        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".players
          (id, provider_id, external_player_id, status)
         VALUES (?, ?, ?, 'ACTIVE')`,
            [randomUUID(), randomUUID(), `missing-provider-${randomUUID()}`],
          ),
        ).rejects.toThrow();

        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
          (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'BRL', '0.00', 1)`,
            [randomUUID(), first.providerId, second.playerId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
          (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'BRL', '0.00', 1)`,
            [randomUUID(), first.providerId, first.playerId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
          (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'BRL', '-0.01', 1)`,
            [randomUUID(), first.providerId, first.playerId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wallets
          (id, provider_id, player_id, currency, balance, version)
         VALUES (?, ?, ?, 'brl', '0.00', 1)`,
            [randomUUID(), first.providerId, first.playerId],
          ),
        ).rejects.toThrow();

        await operation(
          operationIds.first,
          first.providerId,
          `constraint-key-${randomUUID()}`,
          `constraint-external-${randomUUID()}`,
        );
        const originalOperation = await integrationContext.orm.em.execute<
          { idempotency_key: string; external_transaction_id: string }[]
        >(
          `SELECT idempotency_key, external_transaction_id
       FROM "${integrationContext.schema}".financial_operations WHERE id = ?`,
          [operationIds.first],
        );
        const firstOperation = originalOperation[0];
        if (firstOperation === undefined) {
          throw new Error("Direct SQL financial operation was not persisted");
        }
        await expect(
          operation(
            operationIds.duplicateIdempotency,
            first.providerId,
            firstOperation.idempotency_key,
            `distinct-external-${randomUUID()}`,
          ),
        ).rejects.toThrow();
        await expect(
          operation(
            operationIds.duplicateExternalId,
            first.providerId,
            `distinct-key-${randomUUID()}`,
            firstOperation.external_transaction_id,
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".financial_operations
          (id, provider_id, idempotency_key, external_transaction_id,
           payload_hash, response_snapshot, response_http_status)
         VALUES (?, ?, ?, ?, 'invalid-hash', '{}'::jsonb, 202)`,
            [
              randomUUID(),
              first.providerId,
              `invalid-hash-${randomUUID()}`,
              `invalid-hash-external-${randomUUID()}`,
            ],
          ),
        ).rejects.toThrow();

        await operation(
          operationIds.pendingWager,
          first.providerId,
          `wager-key-${randomUUID()}`,
          `wager-external-${randomUUID()}`,
        );
        await pendingWager(
          randomUUID(),
          first.providerId,
          first.playerId,
          first.walletId,
          operationIds.pendingWager,
          `wager-row-${randomUUID()}`,
        );
        await operation(
          operationIds.pendingWagerDuplicateOperation,
          first.providerId,
          `wager-key-duplicate-${randomUUID()}`,
          `wager-external-duplicate-${randomUUID()}`,
        );
        await expect(
          pendingWager(
            randomUUID(),
            first.providerId,
            first.playerId,
            first.walletId,
            operationIds.pendingWager,
            `duplicate-operation-${randomUUID()}`,
          ),
        ).rejects.toThrow();

        await operation(
          operationIds.secondProviderWager,
          second.providerId,
          `other-provider-wager-${randomUUID()}`,
          `other-provider-wager-external-${randomUUID()}`,
        );
        await pendingWager(
          operationIds.secondProviderWager,
          second.providerId,
          second.playerId,
          second.walletId,
          operationIds.secondProviderWager,
          `other-provider-target-${randomUUID()}`,
        );
        await operation(
          operationIds.crossProvider,
          first.providerId,
          `cross-provider-reference-${randomUUID()}`,
          `cross-provider-reference-external-${randomUUID()}`,
        );
        await expect(
          pendingWager(
            operationIds.crossProviderReference,
            first.providerId,
            first.playerId,
            first.walletId,
            operationIds.crossProvider,
            `cross-provider-reference-row-${randomUUID()}`,
            operationIds.secondProviderWager,
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wager_transactions
          (id, provider_id, player_id, wallet_id, financial_operation_id,
           external_transaction_id, kind, status, amount, currency)
         VALUES (?, ?, ?, ?, ?, ?, 'BET', 'PENDING', '0.00', 'BRL')`,
            [
              randomUUID(),
              first.providerId,
              first.playerId,
              first.walletId,
              operationIds.crossProvider,
              `invalid-amount-${randomUUID()}`,
            ],
          ),
        ).rejects.toThrow();

        await expect(
          integrationContext.orm.em.execute(
            `INSERT INTO "${integrationContext.schema}".wager_transactions
          (id, provider_id, player_id, wallet_id, kind, status, amount,
           currency, processed_at, completed_at)
         VALUES (?, ?, ?, ?, 'OPENING', 'PROCESSED', '1.00', 'BRL', now(), now())`,
            [randomUUID(), first.providerId, first.playerId, first.walletId],
          ),
        ).rejects.toThrow();

        const opening = await integrationContext.orm.em.execute<
          { id: string }[]
        >(
          `SELECT id FROM "${integrationContext.schema}".wager_transactions
       WHERE wallet_id = ? AND kind = 'OPENING'`,
          [first.walletId],
        );
        const openingId = opening[0]?.id;
        if (openingId === undefined) {
          throw new Error(
            "Seeded wallet opening transaction was not persisted",
          );
        }
        await expect(
          integrationContext.orm.em.execute(
            `UPDATE "${integrationContext.schema}".wallet_ledger_entries
         SET amount = '11.00' WHERE wager_transaction_id = ?`,
            [openingId],
          ),
        ).rejects.toThrow();
        await expect(
          integrationContext.orm.em.execute(
            `DELETE FROM "${integrationContext.schema}".wallet_ledger_entries
         WHERE wager_transaction_id = ?`,
            [openingId],
          ),
        ).rejects.toThrow();
      });

      test("refuses a wallet created with a balance the Ledger does not explain", async () => {
        const context = await integrationContext.seedWagerContext("0.00");
        const funded = {
          provider_id: context.providerId,
          player_id: context.playerId,
          balance: "10.00",
          version: 1,
        };

        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.wallets.create({
              ...funded,
              id: randomUUID(),
              currency: "USD",
            }),
          ),
        ).rejects.toMatchObject({ code: "23514" });

        const walletId = randomUUID();
        await integrationContext.transactionManager.transaction((session) =>
          createWalletWithOpening(session, {
            ...funded,
            id: walletId,
            currency: "EUR",
          }),
        );
        expect(
          (
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(walletId),
            )
          )?.balance,
        ).toBe("10.00");
      });

      test("allows only one internal OPENING transaction for a wallet", async () => {
        const context = await integrationContext.seedWagerContext("0.00");
        const createOpening = () => {
          const opening = WagerTransaction.createOpening({
            id: randomUUID(),
            providerId: context.providerId,
            playerId: context.playerId,
            walletId: context.walletId,
            amount: "10.00",
            currency: "BRL",
          });
          opening.markProcessed();
          const snapshot = opening.snapshot();
          return integrationContext.transactionManager.transaction(
            async (session) => {
              await session.wagerTransactions.create({
                id: snapshot.id,
                provider_id: snapshot.providerId,
                player_id: snapshot.playerId,
                wallet_id: snapshot.walletId,
                financial_operation_id: snapshot.financialOperationId,
                external_transaction_id: snapshot.externalTransactionId,
                external_reference_transaction_id:
                  snapshot.externalReferenceTransactionId,
                reference_transaction_id: snapshot.referenceTransactionId,
                round_id: snapshot.roundId,
                game_id: snapshot.gameId,
                kind: snapshot.kind,
                status: snapshot.status,
                amount: snapshot.amount,
                currency: snapshot.currency,
                failure_code: snapshot.failureCode,
                reference_attempts: 0,
                next_reference_attempt_at: null,
                reference_expires_at: null,
                processed_at:
                  snapshot.processedAt === null
                    ? null
                    : new Date(snapshot.processedAt),
                completed_at:
                  snapshot.completedAt === null
                    ? null
                    : new Date(snapshot.completedAt),
              });
              const updatedWallet = await session.wallets.updateBalance(
                context.walletId,
                1,
                "10.00",
              );
              if (updatedWallet === null) {
                throw new Error("Opening wallet balance update failed");
              }
              await session.walletLedger.create({
                id: randomUUID(),
                provider_id: context.providerId,
                player_id: context.playerId,
                wallet_id: context.walletId,
                wager_transaction_id: snapshot.id,
                amount: "10.00",
                entry_type: "CREDIT",
                balance_before: "0.00",
                balance_after: "10.00",
              });
            },
          );
        };

        await createOpening();
        await expect(createOpening()).rejects.toThrow("uq_wallet_opening");
        const openings = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count FROM "${integrationContext.schema}".wager_transactions
       WHERE wallet_id = ? AND kind = 'OPENING'`,
          [context.walletId],
        );
        expect(openings[0]?.count).toBe("1");
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("10.00");
      });

      test("enforces idempotency keys and composite wager references", async () => {
        const firstProviderId = randomUUID();
        const secondProviderId = randomUUID();
        const firstPlayerId = randomUUID();
        const secondPlayerId = randomUUID();
        const firstWalletId = randomUUID();
        const secondWalletId = randomUUID();
        const firstOperationId = randomUUID();
        const secondOperationId = randomUUID();
        const targetWagerId = randomUUID();

        await integrationContext.transactionManager.transaction(
          async (session) => {
            await session.providers.create({
              id: firstProviderId,
              code: "composite-provider-one",
              name: "Composite Provider One",
              status: "ACTIVE",
            });
            await session.providers.create({
              id: secondProviderId,
              code: "composite-provider-two",
              name: "Composite Provider Two",
              status: "ACTIVE",
            });
            await session.players.create({
              id: firstPlayerId,
              provider_id: firstProviderId,
              external_player_id: "composite-player-one",
              status: "ACTIVE",
            });
            await session.players.create({
              id: secondPlayerId,
              provider_id: secondProviderId,
              external_player_id: "composite-player-two",
              status: "ACTIVE",
            });
            await createWalletWithOpening(session, {
              id: firstWalletId,
              provider_id: firstProviderId,
              player_id: firstPlayerId,
              currency: "BRL",
              balance: "10.00",
              version: 1,
            });
            await createWalletWithOpening(session, {
              id: secondWalletId,
              provider_id: secondProviderId,
              player_id: secondPlayerId,
              currency: "BRL",
              balance: "10.00",
              version: 1,
            });
            await session.financialOperations.create({
              id: firstOperationId,
              provider_id: firstProviderId,
              idempotency_key: "composite-key",
              external_transaction_id: "composite-external-one",
              payload_hash: "c".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: null,
            });
            await session.financialOperations.create({
              id: secondOperationId,
              provider_id: secondProviderId,
              idempotency_key: "composite-key",
              external_transaction_id: "composite-external-two",
              payload_hash: "d".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: null,
            });
            await session.wagerTransactions.create({
              id: targetWagerId,
              provider_id: firstProviderId,
              player_id: firstPlayerId,
              wallet_id: firstWalletId,
              financial_operation_id: firstOperationId,
              external_transaction_id: "composite-external-one",
              external_reference_transaction_id: null,
              reference_transaction_id: null,
              round_id: null,
              game_id: null,
              kind: "BET",
              status: "PENDING",
              amount: "1.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: null,
              completed_at: null,
            });
          },
        );

        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.financialOperations.create({
              id: randomUUID(),
              provider_id: firstProviderId,
              idempotency_key: "composite-key",
              external_transaction_id: "new-external-id",
              payload_hash: "e".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: null,
            }),
          ),
        ).rejects.toThrow();

        await expect(
          integrationContext.transactionManager.transaction((session) =>
            session.financialOperations.create({
              id: randomUUID(),
              provider_id: firstProviderId,
              idempotency_key: "new-idempotency-key",
              external_transaction_id: "composite-external-one",
              payload_hash: "f".repeat(64),
              response_snapshot: {},
              response_http_status: 200,
              completed_at: null,
            }),
          ),
        ).rejects.toThrow();

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            await session.wagerTransactions.create({
              id: randomUUID(),
              provider_id: firstProviderId,
              player_id: firstPlayerId,
              wallet_id: firstWalletId,
              financial_operation_id: secondOperationId,
              external_transaction_id: "wrong-provider-operation",
              external_reference_transaction_id: null,
              reference_transaction_id: targetWagerId,
              round_id: null,
              game_id: null,
              kind: "REFUND",
              status: "PENDING",
              amount: "1.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: null,
              completed_at: null,
            });
          }),
        ).rejects.toThrow();

        await expect(
          integrationContext.transactionManager.transaction(async (session) => {
            await session.wagerTransactions.create({
              id: randomUUID(),
              provider_id: secondProviderId,
              player_id: secondPlayerId,
              wallet_id: secondWalletId,
              financial_operation_id: secondOperationId,
              external_transaction_id: "cross-wallet-reference",
              external_reference_transaction_id: "composite-external-one",
              reference_transaction_id: targetWagerId,
              round_id: null,
              game_id: null,
              kind: "ROLLBACK",
              status: "PENDING",
              amount: "1.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: null,
              completed_at: null,
            });
          }),
        ).rejects.toThrow();
      });
    });
  },
);
