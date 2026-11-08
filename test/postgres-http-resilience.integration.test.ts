import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import { randomUUID } from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL HTTP commit and transient failure behavior",
  (integrationContext) => {
    describe("HTTP commit and transient failure behavior", () => {
      test("does not return HTTP success until the financial transaction commits", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const provider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(context.providerId),
          );
        if (provider === null) {
          throw new Error("Seeded provider was not persisted");
        }

        const apiKey = `${randomUUID()}-${randomUUID()}`;
        const port = await integrationContext.findAvailableHttpPort();
        const apiWorker = integrationContext.runHttpApiWorkerProcess(
          port,
          provider.code,
          apiKey,
        );
        const baseUrl = `http://127.0.0.1:${port}`;
        const externalTransactionId = `commit-gated-${randomUUID()}`;
        const triggerName = `http_commit_gate_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        const sequenceName = `${triggerName}_sequence`;
        let triggerCreated = false;

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          await integrationContext.orm.em.execute(
            `CREATE SEQUENCE "${integrationContext.schema}"."${sequenceName}" START WITH 1`,
          );
          await integrationContext.orm.em.execute(
            `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF nextval('"${integrationContext.schema}"."${sequenceName}"'::regclass) = 1 THEN
             PERFORM pg_sleep(2);
           END IF;
           RETURN NEW;
         END;
         $$`,
          );
          await integrationContext.orm.em.execute(
            `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON "${integrationContext.schema}".outbox
         FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          triggerCreated = true;

          let responseReceived = false;
          const responsePromise = fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-provider-code": provider.code,
              "x-provider-key": apiKey,
              "idempotency-key": `commit-gated-key-${randomUUID()}`,
            },
            body: JSON.stringify({
              playerId: context.playerId,
              walletId: context.walletId,
              externalTransactionId,
              kind: "BET",
              money: { amount: "10.00", currency: "BRL" },
            }),
          }).then((response) => {
            responseReceived = true;
            return response;
          });

          let transactionPaused = false;
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const activity = await integrationContext.orm.em.execute<
              { count: string }[]
            >(
              `SELECT count(*)::text AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND state = 'active'
             AND wait_event = 'PgSleep'
             AND query ILIKE '%outbox%'`,
            );
            if (activity[0]?.count === "1") {
              transactionPaused = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(transactionPaused).toBe(true);
          expect(responseReceived).toBe(false);

          const beforeCommit = await integrationContext.orm.em.execute<
            {
              operation_count: string;
              balance: string;
            }[]
          >(
            `SELECT
           (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS operation_count,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance`,
            [context.providerId, externalTransactionId, context.walletId],
          );
          expect(beforeCommit[0]).toEqual({
            operation_count: "0",
            balance: "50.00",
          });

          const response = await responsePromise;
          expect(response.status).toBe(200);
          const responseBody = await response.json();
          expect(responseBody).toMatchObject({
            externalTransactionId,
            status: "PROCESSED",
            balance: { amount: "40.00", currency: "BRL" },
            idempotentReplay: false,
          });
          const committed = await integrationContext.orm.em.execute<
            {
              response_http_status: number;
              response_snapshot: unknown;
              completed_at: Date | null;
              balance: string;
            }[]
          >(
            `SELECT operation.response_http_status,
                operation.response_snapshot,
                operation.completed_at,
                wallet.balance::text AS balance
         FROM "${integrationContext.schema}".financial_operations operation
         JOIN "${integrationContext.schema}".wallets wallet ON wallet.provider_id = operation.provider_id
         WHERE operation.provider_id = ? AND operation.external_transaction_id = ?`,
            [context.providerId, externalTransactionId],
          );
          // The stored snapshot is what a replay is answered from: same
          // transaction, status and balance the client received.
          expect(committed[0]).toMatchObject({
            response_http_status: 200,
            response_snapshot: {
              externalTransactionId,
              status: "PROCESSED",
              transaction: { id: responseBody.transactionId },
              wallet: { balance: "40.00" },
            },
            completed_at: expect.any(String),
            balance: "40.00",
          });
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.walletId,
          );
        } finally {
          if (triggerCreated) {
            await integrationContext.orm.em.execute(
              `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".outbox`,
            );
            await integrationContext.orm.em.execute(
              `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
            );
          }
          await integrationContext.orm.em.execute(
            `DROP SEQUENCE IF EXISTS "${integrationContext.schema}"."${sequenceName}"`,
          );
          if (apiWorker.exitCode === null && apiWorker.signalCode === null) {
            const stopped = new Promise<void>((resolve) =>
              apiWorker.once("close", () => resolve()),
            );
            apiWorker.kill("SIGTERM");
            await stopped;
          }
        }
      }, 30_000);

      test("replays an HTTP insufficient-funds rejection without changing the wallet or ledger", async () => {
        const context = await integrationContext.seedWagerContext("20.00");
        const provider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(context.providerId),
          );
        if (provider === null) {
          throw new Error("Seeded provider was not persisted");
        }

        const apiKey = `${randomUUID()}-${randomUUID()}`;
        const port = await integrationContext.findAvailableHttpPort();
        const apiWorker = integrationContext.runHttpApiWorkerProcess(
          port,
          provider.code,
          apiKey,
        );
        const baseUrl = `http://127.0.0.1:${port}`;

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          const requestBody = {
            playerId: context.playerId,
            walletId: context.walletId,
            externalTransactionId: `http-insufficient-${randomUUID()}`,
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          };
          const headers = {
            "content-type": "application/json",
            "x-provider-code": provider.code,
            "x-provider-key": apiKey,
            "idempotency-key": `http-insufficient-key-${randomUUID()}`,
          };
          const firstResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
            },
          );
          expect(firstResponse.status).toBe(422);
          const first = (await firstResponse.json()) as {
            readonly transactionId: string | null;
            readonly status: string;
            readonly failureCode: string | null;
            readonly balance: {
              readonly amount: string;
              readonly currency: string;
            } | null;
            readonly idempotentReplay: boolean;
          };
          expect(first.status).toBe("REJECTED");
          expect(first.failureCode).toBe("INSUFFICIENT_FUNDS");
          expect(first.transactionId).not.toBeNull();
          expect(first.balance).toEqual({ amount: "20.00", currency: "BRL" });
          expect(first.idempotentReplay).toBe(false);

          const replayResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
            },
          );
          expect(replayResponse.status).toBe(422);
          expect(await replayResponse.json()).toEqual({
            ...first,
            idempotentReplay: true,
          });

          const conflictResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                ...requestBody,
                money: { amount: "31.00", currency: "BRL" },
              }),
            },
          );
          expect(conflictResponse.status).toBe(409);

          const persisted = await integrationContext.orm.em.execute<
            {
              operation_count: string;
              wager_count: string;
              ledger_count: string;
              balance: string;
              version: number;
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
            )) AS ledger_count,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance,
           (SELECT version FROM "${integrationContext.schema}".wallets WHERE id = ?) AS version`,
            [
              context.providerId,
              headers["idempotency-key"],
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
              context.walletId,
            ],
          );
          expect(persisted[0]).toEqual({
            operation_count: "1",
            wager_count: "1",
            ledger_count: "0",
            balance: "20.00",
            version: 2,
          });
        } finally {
          if (apiWorker.exitCode === null) {
            const stopped = new Promise<void>((resolve) =>
              apiWorker.once("close", () => resolve()),
            );
            apiWorker.kill("SIGTERM");
            await stopped;
          }
        }
      });

      test("returns 503 and safely recovers the same HTTP wager after a transient PostgreSQL failure", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const provider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(context.providerId),
          );
        if (provider === null) {
          throw new Error("Seeded provider was not persisted");
        }

        const apiKey = `${randomUUID()}-${randomUUID()}`;
        const port = await integrationContext.findAvailableHttpPort();
        const apiWorker = integrationContext.runHttpApiWorkerProcess(
          port,
          provider.code,
          apiKey,
        );
        const baseUrl = `http://127.0.0.1:${port}`;
        const triggerName = `http_transient_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        let triggerCreated = false;

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          await integrationContext.orm.em.execute(
            `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'injected transient database outage'
             USING ERRCODE = '57P01';
         END;
         $$`,
          );
          await integrationContext.orm.em.execute(
            `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON "${integrationContext.schema}".outbox
         FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          triggerCreated = true;

          const requestBody = {
            playerId: context.playerId,
            walletId: context.walletId,
            externalTransactionId: `http-transient-${randomUUID()}`,
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          };
          const headers = {
            "content-type": "application/json",
            "x-provider-code": provider.code,
            "x-provider-key": apiKey,
            "idempotency-key": `http-transient-key-${randomUUID()}`,
          };
          const failedResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
            },
          );
          expect(failedResponse.status).toBe(503);
          expect(await failedResponse.json()).toMatchObject({
            statusCode: 503,
            code: "DEPENDENCY_UNAVAILABLE",
          });

          const afterFailure = await integrationContext.orm.em.execute<
            {
              operation_count: string;
              wager_count: string;
              ledger_count: string;
              balance: string;
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
            )) AS ledger_count,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance`,
            [
              context.providerId,
              headers["idempotency-key"],
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
            ],
          );
          expect(afterFailure[0]).toEqual({
            operation_count: "0",
            wager_count: "0",
            ledger_count: "0",
            balance: "100.00",
          });

          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".outbox`,
          );
          triggerCreated = false;
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );

          const recoveredResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(requestBody),
            },
          );
          expect(recoveredResponse.status).toBe(200);
          const recovered = (await recoveredResponse.json()) as {
            readonly status: string;
            readonly balance: { readonly amount: string } | null;
          };
          expect(recovered.status).toBe("PROCESSED");
          expect(recovered.balance?.amount).toBe("90.00");

          const finalState = await integrationContext.orm.em.execute<
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
            WHERE provider_id = ? AND idempotency_key = ?) AS operation_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?) AS wager_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = ? AND wager_transaction_id IN (
              SELECT id FROM "${integrationContext.schema}".wager_transactions
              WHERE provider_id = ? AND external_transaction_id = ?
            )) AS ledger_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
            WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') IN (
              SELECT id::text FROM "${integrationContext.schema}".wager_transactions
              WHERE provider_id = ? AND external_transaction_id = ?
            )) AS outbox_count,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance`,
            [
              context.providerId,
              headers["idempotency-key"],
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
              context.providerId,
              requestBody.externalTransactionId,
              context.providerId,
              requestBody.externalTransactionId,
              context.walletId,
            ],
          );
          expect(finalState[0]).toEqual({
            operation_count: "1",
            wager_count: "1",
            ledger_count: "1",
            outbox_count: "2",
            balance: "90.00",
          });
        } finally {
          if (triggerCreated) {
            await integrationContext.orm.em.execute(
              `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".outbox`,
            );
            await integrationContext.orm.em.execute(
              `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
            );
          }
          if (apiWorker.exitCode === null) {
            const stopped = new Promise<void>((resolve) =>
              apiWorker.once("close", () => resolve()),
            );
            apiWorker.kill("SIGTERM");
            await stopped;
          }
        }
      });
    });
  },
);
