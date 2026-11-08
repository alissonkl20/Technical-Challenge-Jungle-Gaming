import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  Migration20261106190000,
  Migration20261106200000,
  Migration20261106210000,
  Migration20261107230000,
  Migration20261108100000,
  Migration20261108110000,
  Migration20261108120000,
  Migration20261108130000,
  Migration20261108140000,
  Migration20261108150000,
  Migration20261108160000,
  Migration20261109100000,
  MikroORM,
  MikroOrmTransactionManager,
  mikroOrmConfig,
  PlayersService,
  type PostgreSqlDriver,
  type PostgreSqlEntityManager,
  ProvidersService,
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
  WalletsService,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL financial reconciliation",
  (integrationContext) => {
    describe("financial reconciliation", () => {
      test("reconciles every wallet and financial movement in an isolated PostgreSQL schema", async () => {
        const auditSchema = `it_reconcile_${randomUUID().replaceAll("-", "")}`;
        await integrationContext.cleanupOrm.em.execute(
          `CREATE SCHEMA "${auditSchema}"`,
        );
        let auditOrm:
          | Awaited<
              ReturnType<
                typeof MikroORM.init<PostgreSqlDriver, PostgreSqlEntityManager>
              >
            >
          | undefined;

        try {
          auditOrm = await MikroORM.init<
            PostgreSqlDriver,
            PostgreSqlEntityManager
          >({
            ...mikroOrmConfig,
            schema: auditSchema,
            migrations: {
              ...mikroOrmConfig.migrations,
              schema: auditSchema,
              snapshot: false,
              migrationsList: [
                Migration20261106190000,
                Migration20261106200000,
                Migration20261106210000,
                Migration20261107230000,
                Migration20261108100000,
                Migration20261108110000,
                Migration20261108120000,
                Migration20261108130000,
                Migration20261108140000,
                Migration20261108150000,
                Migration20261108160000,
                Migration20261109100000,
              ],
            },
          });
          await auditOrm.migrator.up();
          const auditTransactions = new MikroOrmTransactionManager(auditOrm.em);
          const auditProviders = new ProvidersService(auditTransactions);
          const auditPlayers = new PlayersService(auditTransactions);
          const auditWallets = new WalletsService(auditTransactions);
          const auditWagers = new WagerTransactionsService(auditTransactions);
          const provider = await auditProviders.register({
            code: `reconcile-${randomUUID()}`,
            name: "Reconciliation Provider",
          });
          const firstPlayer = await auditPlayers.register(provider.id, {
            externalPlayerId: "reconcile-player-1",
          });
          const secondPlayer = await auditPlayers.register(provider.id, {
            externalPlayerId: "reconcile-player-2",
          });
          const firstWallet = await auditWallets.open(
            provider.id,
            firstPlayer.id,
            "BRL",
            { amount: "100.00", currency: "BRL" },
          );
          const secondWallet = await auditWallets.open(
            provider.id,
            secondPlayer.id,
            "BRL",
            { amount: "1.00", currency: "BRL" },
          );

          const concurrentBets = Array.from({ length: 30 }, (_, index) => ({
            key: `reconcile-bet-key-${index}-${randomUUID()}`,
            externalId: `reconcile-bet-${index}-${randomUUID()}`,
          }));
          const betResults = await Promise.all(
            concurrentBets.map(({ key, externalId }) =>
              auditWagers.process(
                provider.id,
                key,
                integrationContext.wagerInput(
                  firstPlayer.externalPlayerId,
                  externalId,
                  {
                    amount: "10.00",
                  },
                ),
              ),
            ),
          );
          const processedBetIndex = betResults.findIndex(
            (result) => result.response.status === "PROCESSED",
          );
          const processedBet = concurrentBets[processedBetIndex];
          if (processedBet === undefined || processedBetIndex < 0) {
            throw new Error("Reconciliation scenario did not process any BET");
          }
          const refund = await auditWagers.process(
            provider.id,
            `reconcile-refund-key-${randomUUID()}`,
            integrationContext.wagerInput(
              firstPlayer.externalPlayerId,
              `reconcile-refund-${randomUUID()}`,
              {
                kind: WagerTransactionKind.REFUND,
                externalReferenceTransactionId: processedBet.externalId,
              },
            ),
          );
          expect(refund.response.status).toBe("PROCESSED");
          await auditWagers.process(
            provider.id,
            `reconcile-loss-key-${randomUUID()}`,
            integrationContext.wagerInput(
              firstPlayer.externalPlayerId,
              `reconcile-loss-${randomUUID()}`,
              {
                kind: WagerTransactionKind.LOSS,
                amount: "10.00",
                externalReferenceTransactionId:
                  concurrentBets[
                    betResults.findIndex(
                      (result, index) =>
                        index !== processedBetIndex &&
                        result.response.status === "PROCESSED",
                    )
                  ]?.externalId,
              },
            ),
          );
          const pending = await auditWagers.process(
            provider.id,
            `reconcile-pending-key-${randomUUID()}`,
            integrationContext.wagerInput(
              firstPlayer.externalPlayerId,
              `reconcile-pending-${randomUUID()}`,
              {
                kind: WagerTransactionKind.WIN,
                amount: "5.00",
                externalReferenceTransactionId: `missing-reference-${randomUUID()}`,
              },
            ),
          );
          expect(pending.response.status).toBe("PENDING_REFERENCE");

          const secondCreditId = `reconcile-second-credit-${randomUUID()}`;
          const secondStakeId = `reconcile-second-stake-${randomUUID()}`;
          await auditWagers.process(
            provider.id,
            `${secondStakeId}-key`,
            integrationContext.wagerInput(
              secondPlayer.externalPlayerId,
              secondStakeId,
              { amount: "1.00" },
            ),
          );
          await auditWagers.process(
            provider.id,
            `reconcile-second-credit-key-${randomUUID()}`,
            integrationContext.wagerInput(
              secondPlayer.externalPlayerId,
              secondCreditId,
              {
                kind: WagerTransactionKind.WIN,
                amount: "50.00",
                externalReferenceTransactionId: secondStakeId,
              },
            ),
          );
          const rollback = await auditWagers.process(
            provider.id,
            `reconcile-rollback-key-${randomUUID()}`,
            integrationContext.wagerInput(
              secondPlayer.externalPlayerId,
              `reconcile-rollback-${randomUUID()}`,
              {
                kind: WagerTransactionKind.ROLLBACK,
                amount: "50.00",
                externalReferenceTransactionId: secondCreditId,
              },
            ),
          );
          expect(rollback.response.status).toBe("PROCESSED");

          const walletMismatches = await auditOrm.em.execute<
            { wallet_id: string; balance: string; ledger_balance: string }[]
          >(
            `SELECT wallet.id AS wallet_id,
                wallet.balance::text AS balance,
                COALESCE(
                  SUM(
                    CASE entry.entry_type
                      WHEN 'CREDIT' THEN entry.amount
                      ELSE -entry.amount
                    END
                  ),
                  0
                )::numeric(20, 2)::text AS ledger_balance
         FROM "${auditSchema}".wallets wallet
         LEFT JOIN "${auditSchema}".wallet_ledger_entries entry
           ON entry.wallet_id = wallet.id
         GROUP BY wallet.id
         HAVING wallet.balance <> COALESCE(
           SUM(
             CASE entry.entry_type
               WHEN 'CREDIT' THEN entry.amount
               ELSE -entry.amount
             END
           ),
           0
         )`,
          );
          expect(walletMismatches).toEqual([]);

          const movementMismatches = await auditOrm.em.execute<
            {
              transaction_id: string;
              status: string;
              kind: string;
              has_ledger: boolean;
            }[]
          >(
            `SELECT wager.id AS transaction_id,
                wager.status,
                wager.kind,
                ledger.id IS NOT NULL AS has_ledger
         FROM "${auditSchema}".wager_transactions wager
         LEFT JOIN "${auditSchema}".wallet_ledger_entries ledger
           ON ledger.wager_transaction_id = wager.id
         WHERE (wager.status = 'PROCESSED'
                AND wager.kind IN ('OPENING', 'BET', 'WIN', 'REFUND', 'ROLLBACK')
                AND ledger.id IS NULL)
            OR ((wager.status <> 'PROCESSED'
                  OR wager.kind IN ('LOSS'))
                AND ledger.id IS NOT NULL)`,
          );
          expect(movementMismatches).toEqual([]);

          const ledgerMismatches = await auditOrm.em.execute<
            { ledger_id: string; transaction_id: string }[]
          >(
            `SELECT ledger.id AS ledger_id,
                wager.id AS transaction_id
         FROM "${auditSchema}".wallet_ledger_entries ledger
         JOIN "${auditSchema}".wager_transactions wager
           ON wager.id = ledger.wager_transaction_id
         LEFT JOIN "${auditSchema}".wallet_ledger_entries target_ledger
           ON target_ledger.wager_transaction_id =
              wager.reference_transaction_id
         WHERE wager.status <> 'PROCESSED'
            OR ledger.provider_id <> wager.provider_id
            OR ledger.player_id <> wager.player_id
            OR ledger.wallet_id <> wager.wallet_id
            OR ledger.amount <> wager.amount
            OR ledger.entry_type <> CASE
              WHEN wager.kind IN ('OPENING', 'WIN', 'REFUND') THEN 'CREDIT'
              WHEN wager.kind = 'BET' THEN 'DEBIT'
              WHEN wager.kind = 'ROLLBACK'
                THEN CASE target_ledger.entry_type
                  WHEN 'CREDIT' THEN 'DEBIT'
                  WHEN 'DEBIT' THEN 'CREDIT'
                  ELSE NULL
                END
              ELSE NULL
            END`,
          );
          expect(ledgerMismatches).toEqual([]);

          const operationMismatches = await auditOrm.em.execute<
            {
              operation_id: string | null;
              wager_id: string | null;
            }[]
          >(
            `SELECT operation.id AS operation_id,
                wager.id AS wager_id
         FROM "${auditSchema}".financial_operations operation
         FULL OUTER JOIN "${auditSchema}".wager_transactions wager
           ON wager.financial_operation_id = operation.id
         WHERE (operation.id IS NOT NULL AND wager.id IS NULL)
            OR (wager.id IS NOT NULL AND wager.kind <> 'OPENING'
                AND operation.id IS NULL)
            OR (operation.id IS NOT NULL AND wager.id IS NOT NULL
                AND (
                  operation.provider_id <> wager.provider_id
                  OR operation.external_transaction_id
                    IS DISTINCT FROM wager.external_transaction_id
                  OR operation.response_snapshot->>'status'
                    IS DISTINCT FROM wager.status
                ))`,
          );
          expect(operationMismatches).toEqual([]);

          const duplicateApplications = await auditOrm.em.execute<
            {
              record_type: string;
              transaction_id: string;
              record_count: string;
            }[]
          >(
            `SELECT record_type, transaction_id, count(*)::text AS record_count
         FROM (
           SELECT 'wager'::text AS record_type,
                  financial_operation_id AS transaction_id
           FROM "${auditSchema}".wager_transactions
           WHERE kind <> 'OPENING'
           UNION ALL
           SELECT 'ledger'::text AS record_type,
                  wager_transaction_id AS transaction_id
           FROM "${auditSchema}".wallet_ledger_entries
         ) applications
         GROUP BY record_type, transaction_id
         HAVING count(*) > 1`,
          );
          expect(duplicateApplications).toEqual([]);

          const ledgerIdentityMismatches = await auditOrm.em.execute<
            {
              ledger_id: string;
              wallet_id: string | null;
              wager_id: string | null;
            }[]
          >(
            `SELECT ledger.id AS ledger_id,
                wallet.id AS wallet_id,
                wager.id AS wager_id
         FROM "${auditSchema}".wallet_ledger_entries ledger
         LEFT JOIN "${auditSchema}".wallets wallet
           ON wallet.id = ledger.wallet_id
         LEFT JOIN "${auditSchema}".wager_transactions wager
           ON wager.id = ledger.wager_transaction_id
         WHERE wallet.id IS NULL
            OR wager.id IS NULL
            OR ledger.provider_id IS DISTINCT FROM wallet.provider_id
            OR ledger.player_id IS DISTINCT FROM wallet.player_id
            OR ledger.provider_id IS DISTINCT FROM wager.provider_id
            OR ledger.player_id IS DISTINCT FROM wager.player_id
            OR ledger.wallet_id IS DISTINCT FROM wager.wallet_id
            OR wallet.currency IS DISTINCT FROM wager.currency
            OR wager.status <> 'PROCESSED'`,
          );
          expect(ledgerIdentityMismatches).toEqual([]);

          const invalidReversals = await auditOrm.em.execute<
            {
              reversal_id: string;
              target_id: string | null;
            }[]
          >(
            `SELECT reversal.id AS reversal_id,
                target.id AS target_id
         FROM "${auditSchema}".wager_transactions reversal
         LEFT JOIN "${auditSchema}".wager_transactions target
           ON target.id = reversal.reference_transaction_id
         WHERE reversal.status = 'PROCESSED'
           AND reversal.kind IN ('REFUND', 'ROLLBACK')
           AND (
             target.id IS NULL
             OR target.status <> 'PROCESSED'
             OR target.provider_id <> reversal.provider_id
             OR target.player_id <> reversal.player_id
             OR target.wallet_id <> reversal.wallet_id
             OR target.currency <> reversal.currency
             OR target.amount <> reversal.amount
             OR target.round_id IS DISTINCT FROM reversal.round_id
             OR (reversal.kind = 'REFUND' AND target.kind <> 'BET')
             OR (reversal.kind = 'ROLLBACK'
                 AND target.kind NOT IN ('BET', 'WIN', 'REFUND'))
           )`,
          );
          expect(invalidReversals).toEqual([]);

          const duplicateReversals = await auditOrm.em.execute<
            {
              target_id: string;
              reversal_count: string;
            }[]
          >(
            `SELECT reference_transaction_id AS target_id,
                count(*)::text AS reversal_count
         FROM "${auditSchema}".wager_transactions
         WHERE status = 'PROCESSED'
           AND kind IN ('REFUND', 'ROLLBACK')
         GROUP BY reference_transaction_id
         HAVING count(*) > 1`,
          );
          expect(duplicateReversals).toEqual([]);

          const duplicateWallets = await auditOrm.em.execute<
            {
              provider_id: string;
              player_id: string;
              currency: string;
              wallet_count: string;
            }[]
          >(
            `SELECT provider_id, player_id, currency, count(*)::text AS wallet_count
         FROM "${auditSchema}".wallets
         GROUP BY provider_id, player_id, currency
         HAVING count(*) > 1`,
          );
          expect(duplicateWallets).toEqual([]);

          const invalidBalances = await auditOrm.em.execute<
            {
              wallet_id: string;
              balance: string;
            }[]
          >(
            `SELECT id AS wallet_id, balance::text AS balance
         FROM "${auditSchema}".wallets
         WHERE balance < 0`,
          );
          expect(invalidBalances).toEqual([]);

          const counts = await auditOrm.em.execute<
            {
              wallet_count: string;
              wager_count: string;
              processed_count: string;
              rejected_count: string;
              pending_count: string;
              ledger_count: string;
            }[]
          >(
            `SELECT
           (SELECT count(*)::text FROM "${auditSchema}".wallets) AS wallet_count,
           (SELECT count(*)::text FROM "${auditSchema}".wager_transactions) AS wager_count,
           (SELECT count(*)::text FROM "${auditSchema}".wager_transactions
            WHERE status = 'PROCESSED') AS processed_count,
           (SELECT count(*)::text FROM "${auditSchema}".wager_transactions
            WHERE status = 'REJECTED') AS rejected_count,
           (SELECT count(*)::text FROM "${auditSchema}".wager_transactions
            WHERE status = 'PENDING_REFERENCE') AS pending_count,
           (SELECT count(*)::text FROM "${auditSchema}".wallet_ledger_entries)
             AS ledger_count`,
          );
          expect(counts[0]).toEqual({
            wallet_count: "2",
            // 2 OPENING, 30 BET, REFUND, LOSS, pending WIN, stake BET, WIN,
            // ROLLBACK.
            wager_count: "38",
            processed_count: "17",
            rejected_count: "20",
            pending_count: "1",
            // Every processed movement except the LOSS.
            ledger_count: "16",
          });
          const finalBalances = await auditOrm.em.execute<
            { id: string; balance: string }[]
          >(
            `SELECT id, balance::text AS balance
         FROM "${auditSchema}".wallets
         WHERE id IN (?, ?)
         ORDER BY id`,
            [firstWallet.id, secondWallet.id],
          );
          expect(finalBalances.map((wallet) => wallet.balance).sort()).toEqual([
            "0.00",
            "10.00",
          ]);
        } finally {
          await auditOrm?.close(true);
          await integrationContext.cleanupOrm.em.execute(
            `DROP SCHEMA IF EXISTS "${auditSchema}" CASCADE`,
          );
        }
      });
    });
  },
);
