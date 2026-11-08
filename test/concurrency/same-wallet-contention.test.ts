import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../support/postgres-integration-context.js";
import {
  Money,
  randomUUID,
  WagerTransactionsService,
} from "../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL wallet contention and concurrent bets",
  (integrationContext) => {
    describe("wallet contention and concurrent bets", () => {
      test("serializes concurrent bets on the same wallet without overdrawing", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const outcomes = await Promise.all([
          wagers.process(
            context.providerId,
            "concurrent-key-one",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "concurrent-bet-one",
              {
                amount: "80.00",
              },
            ),
          ),
          wagers.process(
            context.providerId,
            "concurrent-key-two",
            integrationContext.wagerInput(
              context.externalPlayerId,
              "concurrent-bet-two",
              {
                amount: "80.00",
              },
            ),
          ),
        ]);

        expect(outcomes.map((item) => item.response.status).sort()).toEqual([
          "PROCESSED",
          "REJECTED",
        ]);
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("20.00");
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
        expect(ledgerRows[0]?.count).toBe("1");
      });

      test("processes exactly ten of thirty distinct concurrent bets against a 100 balance", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const requests = Array.from({ length: 30 }, (_, index) => ({
          idempotencyKey: `thirty-bets-key-${index}-${randomUUID()}`,
          externalTransactionId: `thirty-bets-${index}-${randomUUID()}`,
        }));
        const outcomes = await Promise.all(
          requests.map(({ idempotencyKey, externalTransactionId }) =>
            wagers.process(
              context.providerId,
              idempotencyKey,
              integrationContext.wagerInput(
                context.externalPlayerId,
                externalTransactionId,
                {
                  amount: "10.00",
                },
              ),
            ),
          ),
        );
        const processed = outcomes.filter(
          (outcome) => outcome.response.status === "PROCESSED",
        );
        const rejected = outcomes.filter(
          (outcome) => outcome.response.status === "REJECTED",
        );

        expect(processed).toHaveLength(10);
        expect(rejected).toHaveLength(20);
        expect(
          rejected.every(
            (outcome) => outcome.response.failureCode === "INSUFFICIENT_FUNDS",
          ),
        ).toBe(true);

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            processed_count: string;
            rejected_count: string;
            processed_without_ledger: string;
            rejected_with_ledger: string;
            movement_ledger_count: string;
            debit_total: string;
            balance: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id LIKE 'thirty-bets-%')
           AS operation_count,
         count(*)::text AS wager_count,
         count(*) FILTER (WHERE wager.status = 'PROCESSED')::text
           AS processed_count,
         count(*) FILTER (WHERE wager.status = 'REJECTED')::text
           AS rejected_count,
         count(*) FILTER (
           WHERE wager.status = 'PROCESSED' AND ledger.id IS NULL
         )::text AS processed_without_ledger,
         count(*) FILTER (
           WHERE wager.status = 'REJECTED' AND ledger.id IS NOT NULL
         )::text AS rejected_with_ledger,
         count(ledger.id)::text AS movement_ledger_count,
         COALESCE(sum(ledger.amount), 0)::numeric(20, 2)::text AS debit_total,
         (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?)
           AS balance
       FROM "${integrationContext.schema}".wager_transactions wager
       LEFT JOIN "${integrationContext.schema}".wallet_ledger_entries ledger
         ON ledger.wager_transaction_id = wager.id
       WHERE wager.provider_id = ? AND wager.wallet_id = ?
         AND wager.external_transaction_id LIKE 'thirty-bets-%'`,
          [
            context.providerId,
            context.walletId,
            context.providerId,
            context.walletId,
          ],
        );
        expect(persisted[0]).toMatchObject({
          operation_count: "30",
          wager_count: "30",
          processed_count: "10",
          rejected_count: "20",
          processed_without_ledger: "0",
          rejected_with_ledger: "0",
          movement_ledger_count: "10",
          debit_total: "100.00",
          balance: "0.00",
        });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("preserves financial invariants under a 100-request wallet contention burst", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const requests = Array.from({ length: 100 }, (_, index) => ({
          idempotencyKey: `burst-key-${index}-${randomUUID()}`,
          externalTransactionId: `burst-wager-${index}-${randomUUID()}`,
        }));

        const outcomes = await Promise.all(
          requests.map(({ idempotencyKey, externalTransactionId }) =>
            wagers.process(
              context.providerId,
              idempotencyKey,
              integrationContext.wagerInput(
                context.externalPlayerId,
                externalTransactionId,
                {
                  amount: "1.00",
                },
              ),
            ),
          ),
        );
        expect(
          outcomes.filter((outcome) => outcome.response.status === "PROCESSED"),
        ).toHaveLength(50);
        expect(
          outcomes.filter((outcome) => outcome.response.status === "REJECTED"),
        ).toHaveLength(50);

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            processed_count: string;
            rejected_count: string;
            processed_without_ledger: string;
            rejected_with_ledger: string;
            ledger_count: string;
            debit_total: string;
            balance: string;
            version: number;
            negative_balance_count: string;
            outbox_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id LIKE 'burst-wager-%')
           AS operation_count,
         count(*)::text AS wager_count,
         count(*) FILTER (WHERE wager.status = 'PROCESSED')::text
           AS processed_count,
         count(*) FILTER (WHERE wager.status = 'REJECTED')::text
           AS rejected_count,
         count(*) FILTER (
           WHERE wager.status = 'PROCESSED' AND ledger.id IS NULL
         )::text AS processed_without_ledger,
         count(*) FILTER (
           WHERE wager.status = 'REJECTED' AND ledger.id IS NOT NULL
         )::text AS rejected_with_ledger,
         count(ledger.id)::text AS ledger_count,
         COALESCE(sum(ledger.amount), 0)::numeric(20, 2)::text AS debit_total,
         wallet.balance::text AS balance,
         wallet.version,
         (SELECT count(*)::text FROM "${integrationContext.schema}".wallets
          WHERE id = wallet.id AND balance < 0) AS negative_balance_count,
         (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
          WHERE event_type = 'WalletBalanceChanged'
            AND aggregate_id = wallet.id) AS outbox_count
       FROM "${integrationContext.schema}".wallets wallet
       LEFT JOIN "${integrationContext.schema}".wager_transactions wager
         ON wager.wallet_id = wallet.id
        AND wager.external_transaction_id LIKE 'burst-wager-%'
       LEFT JOIN "${integrationContext.schema}".wallet_ledger_entries ledger
         ON ledger.wager_transaction_id = wager.id
       WHERE wallet.id = ?
       GROUP BY wallet.id`,
          [context.providerId, context.walletId],
        );
        expect(persisted[0]).toEqual({
          operation_count: "100",
          wager_count: "100",
          processed_count: "50",
          rejected_count: "50",
          processed_without_ledger: "0",
          rejected_with_ledger: "0",
          ledger_count: "50",
          debit_total: "50.00",
          balance: "0.00",
          version: 52,
          negative_balance_count: "0",
          outbox_count: "50",
        });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("measures PostgreSQL wager throughput for a 250-request wallet contention burst", async () => {
        const requestCount = 250;
        const openingBalance = 100n;
        const context = await integrationContext.seedWagerContext(
          `${openingBalance}.00`,
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const requestLatencies: number[] = [];
        const requests = Array.from({ length: requestCount }, (_, index) => ({
          idempotencyKey: `load-key-${index}-${randomUUID()}`,
          externalTransactionId: `load-wager-${index}-${randomUUID()}`,
        }));

        const startedAt = performance.now();
        const outcomes = await Promise.all(
          requests.map(async ({ idempotencyKey, externalTransactionId }) => {
            const requestStartedAt = performance.now();
            const outcome = await wagers.process(
              context.providerId,
              idempotencyKey,
              integrationContext.wagerInput(
                context.externalPlayerId,
                externalTransactionId,
                {
                  amount: "1.00",
                },
              ),
            );
            requestLatencies.push(performance.now() - requestStartedAt);
            return outcome;
          }),
        );
        const elapsedMs = performance.now() - startedAt;
        const sortedLatencies = [...requestLatencies].sort(
          (left, right) => left - right,
        );
        const p95LatencyMs =
          sortedLatencies[Math.ceil(sortedLatencies.length * 0.95) - 1];
        const requestsPerSecond = requestCount / (elapsedMs / 1_000);

        expect(outcomes).toHaveLength(requestCount);
        expect(
          outcomes.filter((outcome) => outcome.response.status === "PROCESSED"),
        ).toHaveLength(Number(openingBalance));
        expect(
          outcomes.filter((outcome) => outcome.response.status === "REJECTED"),
        ).toHaveLength(requestCount - Number(openingBalance));

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            wager_count: string;
            processed_count: string;
            rejected_count: string;
            processed_without_ledger: string;
            rejected_with_ledger: string;
            ledger_count: string;
            debit_total: string;
            balance: string;
            version: number;
            outbox_count: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id LIKE 'load-wager-%')
           AS operation_count,
         count(*)::text AS wager_count,
         count(*) FILTER (WHERE wager.status = 'PROCESSED')::text
           AS processed_count,
         count(*) FILTER (WHERE wager.status = 'REJECTED')::text
           AS rejected_count,
         count(*) FILTER (
           WHERE wager.status = 'PROCESSED' AND ledger.id IS NULL
         )::text AS processed_without_ledger,
         count(*) FILTER (
           WHERE wager.status = 'REJECTED' AND ledger.id IS NOT NULL
         )::text AS rejected_with_ledger,
         count(ledger.id)::text AS ledger_count,
         COALESCE(sum(ledger.amount), 0)::numeric(20, 2)::text AS debit_total,
         wallet.balance::text AS balance,
         wallet.version,
         (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
          WHERE event_type = 'WalletBalanceChanged'
            AND aggregate_id = wallet.id) AS outbox_count
       FROM "${integrationContext.schema}".wallets wallet
       LEFT JOIN "${integrationContext.schema}".wager_transactions wager
         ON wager.wallet_id = wallet.id
        AND wager.external_transaction_id LIKE 'load-wager-%'
       LEFT JOIN "${integrationContext.schema}".wallet_ledger_entries ledger
         ON ledger.wager_transaction_id = wager.id
       WHERE wallet.id = ?
       GROUP BY wallet.id`,
          [context.providerId, context.walletId],
        );
        expect(persisted[0]).toEqual({
          operation_count: String(requestCount),
          wager_count: String(requestCount),
          processed_count: String(openingBalance),
          rejected_count: String(requestCount - Number(openingBalance)),
          processed_without_ledger: "0",
          rejected_with_ledger: "0",
          ledger_count: String(openingBalance),
          debit_total: `${openingBalance}.00`,
          balance: "0.00",
          version: 2 + Number(openingBalance),
          outbox_count: String(openingBalance),
        });
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );

        console.info(
          `PostgreSQL contention load: ${requestCount} wagers in ${elapsedMs.toFixed(2)} ms; ` +
            `${requestsPerSecond.toFixed(2)} requests/s; p95 ${p95LatencyMs?.toFixed(2)} ms`,
        );
      });

      test("keeps varied concurrent bets atomic and reconciles only successful movements", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const amounts = ["20.00", "30.00", "40.00", "50.00", "60.00"];
        const requests = amounts.map((amount, index) => ({
          amount,
          idempotencyKey: `varied-bet-key-${index}-${randomUUID()}`,
          externalTransactionId: `varied-bet-${index}-${randomUUID()}`,
        }));
        const outcomes = await Promise.all(
          requests.map(({ amount, idempotencyKey, externalTransactionId }) =>
            wagers.process(
              context.providerId,
              idempotencyKey,
              integrationContext.wagerInput(
                context.externalPlayerId,
                externalTransactionId,
                {
                  amount,
                },
              ),
            ),
          ),
        );
        const processed = outcomes.filter(
          (outcome) => outcome.response.status === "PROCESSED",
        );
        const rejected = outcomes.filter(
          (outcome) => outcome.response.status === "REJECTED",
        );
        expect(processed.length).toBeGreaterThan(0);
        expect(processed.length + rejected.length).toBe(amounts.length);
        expect(
          rejected.every(
            (outcome) => outcome.response.failureCode === "INSUFFICIENT_FUNDS",
          ),
        ).toBe(true);

        const persisted = await integrationContext.orm.em.execute<
          {
            operation_count: string;
            processed_count: string;
            rejected_count: string;
            processed_without_ledger: string;
            rejected_with_ledger: string;
            processed_amount: string;
            debit_total: string;
            balance: string;
          }[]
        >(
          `SELECT
         (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
          WHERE provider_id = ? AND external_transaction_id LIKE 'varied-bet-%')
           AS operation_count,
         count(*) FILTER (WHERE wager.status = 'PROCESSED')::text
           AS processed_count,
         count(*) FILTER (WHERE wager.status = 'REJECTED')::text
           AS rejected_count,
         count(*) FILTER (
           WHERE wager.status = 'PROCESSED' AND ledger.id IS NULL
         )::text AS processed_without_ledger,
         count(*) FILTER (
           WHERE wager.status = 'REJECTED' AND ledger.id IS NOT NULL
         )::text AS rejected_with_ledger,
         COALESCE(
           sum(wager.amount) FILTER (WHERE wager.status = 'PROCESSED'),
           0
         )::numeric(20, 2)::text AS processed_amount,
         COALESCE(sum(ledger.amount), 0)::numeric(20, 2)::text AS debit_total,
         (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?)
           AS balance
       FROM "${integrationContext.schema}".wager_transactions wager
       LEFT JOIN "${integrationContext.schema}".wallet_ledger_entries ledger
         ON ledger.wager_transaction_id = wager.id
       WHERE wager.provider_id = ? AND wager.wallet_id = ?
         AND wager.external_transaction_id LIKE 'varied-bet-%'`,
          [
            context.providerId,
            context.walletId,
            context.providerId,
            context.walletId,
          ],
        );
        const row = persisted[0];
        expect(row).toBeDefined();
        expect(row?.operation_count).toBe("5");
        expect(row?.processed_count).toBe(String(processed.length));
        expect(row?.rejected_count).toBe(String(rejected.length));
        expect(row?.processed_without_ledger).toBe("0");
        expect(row?.rejected_with_ledger).toBe("0");
        expect(row?.debit_total).toBe(row?.processed_amount);
        const processedTotal = processed.reduce(
          (total, outcome) =>
            total.add(
              Money.fromDecimal(
                outcome.response.transaction?.amount ?? "0.00",
                "BRL",
              ),
            ),
          Money.zero("BRL"),
        );
        expect(row?.processed_amount).toBe(processedTotal.toDecimal());
        expect(
          Money.fromDecimal(row?.balance ?? "0.00", "BRL")
            .add(processedTotal)
            .toDecimal(),
        ).toBe("100.00");
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });
    });
  },
);
