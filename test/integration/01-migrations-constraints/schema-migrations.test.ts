import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import { randomUUID } from "../../support/postgres-test-dependencies.js";
import { createWalletWithOpening } from "../../support/wallet-with-opening.js";

registerPostgresIntegrationSuite(
  "PostgreSQL schema and migrations",
  (integrationContext) => {
    describe("schema and migrations", () => {
      test("migrates the nine tables and persists provider-scoped records", async () => {
        const tableRows = await integrationContext.orm.em.execute<
          { table_name: string }[]
        >(
          `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
          [integrationContext.schema],
        );
        const tables = new Set(tableRows.map((row) => row.table_name));

        expect(tables).toEqual(
          new Set([
            "providers",
            "players",
            "wallets",
            "financial_operations",
            "wager_transactions",
            "wallet_ledger_entries",
            "inbox",
            "outbox",
            "wager_recoveries",
            "mikro_orm_migrations",
          ]),
        );

        const providerId = randomUUID();
        const playerId = randomUUID();
        const walletId = randomUUID();
        const operationId = randomUUID();
        const wagerId = randomUUID();
        const ledgerId = randomUUID();

        await integrationContext.transactionManager.transaction(
          async (session) => {
            const provider = await session.providers.create({
              id: providerId,
              code: "integration-provider",
              name: "Integration Provider",
              status: "ACTIVE",
            });
            expect(provider.id).toBe(providerId);

            const player = await session.players.create({
              id: playerId,
              provider_id: providerId,
              external_player_id: "integration-player",
              status: "ACTIVE",
            });
            expect(player.provider_id).toBe(providerId);
            expect(
              (
                await session.players.findByProviderAndExternalId(
                  providerId,
                  "integration-player",
                )
              )?.id,
            ).toBe(playerId);

            const wallet = await createWalletWithOpening(session, {
              id: walletId,
              provider_id: providerId,
              player_id: playerId,
              currency: "BRL",
              balance: "100.00",
              version: 1,
            });
            expect(wallet.balance).toBe("100.00");
            expect(
              (await session.wallets.findByIdForUpdate(walletId))?.version,
            ).toBe(1);

            const operation = await session.financialOperations.create({
              id: operationId,
              provider_id: providerId,
              idempotency_key: "integration-key",
              external_transaction_id: "integration-external-id",
              payload_hash: "a".repeat(64),
              response_snapshot: { status: "accepted" },
              response_http_status: 202,
              completed_at: null,
            });
            expect(operation.response_http_status).toBe(202);
            expect(
              (
                await session.financialOperations.findByIdempotencyKey(
                  providerId,
                  "integration-key",
                )
              )?.id,
            ).toBe(operationId);

            const wager = await session.wagerTransactions.create({
              id: wagerId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              financial_operation_id: operationId,
              external_transaction_id: "integration-external-id",
              external_reference_transaction_id: null,
              reference_transaction_id: null,
              round_id: "round-1",
              game_id: "game-1",
              kind: "BET",
              status: "PROCESSED",
              amount: "20.00",
              currency: "BRL",
              failure_code: null,
              reference_attempts: 0,
              next_reference_attempt_at: null,
              reference_expires_at: null,
              processed_at: new Date(),
              completed_at: new Date(),
            });
            expect(wager.amount).toBe("20.00");

            const debitedWallet = await session.wallets.updateBalance(
              walletId,
              1,
              "80.00",
            );
            expect(debitedWallet?.version).toBe(2);
            const ledger = await session.walletLedger.create({
              id: ledgerId,
              provider_id: providerId,
              player_id: playerId,
              wallet_id: walletId,
              wager_transaction_id: wagerId,
              amount: "20.00",
              entry_type: "DEBIT",
              balance_before: "100.00",
              balance_after: "80.00",
            });
            expect(ledger.balance_after).toBe("80.00");

            const outbox = await session.outbox.create({
              id: randomUUID(),
              aggregate_id: wagerId,
              event_type: "WagerProcessed",
              payload: { wagerId },
            });
            expect(outbox.status).toBe("PENDING");
          },
        );
      });

      test("reverts every table with the migration down operation", async () => {
        // Revert until no migration is applied, so the test keeps covering
        // every migration when a new one is added.
        for (;;) {
          const applied = await integrationContext.orm.em.execute<
            { name: string }[]
          >(
            `SELECT name FROM "${integrationContext.schema}".mikro_orm_migrations`,
          );
          if (applied.length === 0) break;
          await integrationContext.orm.migrator.down();
        }
        const remainingTables = await integrationContext.orm.em.execute<
          { table_name: string }[]
        >(
          `SELECT table_name FROM information_schema.tables
       WHERE table_schema = ? AND table_type = 'BASE TABLE'
         AND table_name <> 'mikro_orm_migrations'`,
          [integrationContext.schema],
        );

        expect(remainingTables).toEqual([]);
      });
    });
  },
);
