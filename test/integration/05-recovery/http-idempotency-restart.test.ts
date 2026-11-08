import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  randomUUID,
  type spawn,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL HTTP idempotency and restart recovery",
  (integrationContext) => {
    describe("HTTP idempotency and restart recovery", () => {
      test("preserves HTTP financial guarantees across two instances and restart", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const provider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(context.providerId),
          );
        if (provider === null) {
          throw new Error("Seeded provider was not persisted");
        }

        const apiKey = `${randomUUID()}-${randomUUID()}`;
        const firstPort = await integrationContext.findAvailableHttpPort();
        const secondPort = await integrationContext.findAvailableHttpPort();
        const firstInstance = integrationContext.runHttpApiWorkerProcess(
          firstPort,
          provider.code,
          apiKey,
        );
        const secondInstance = integrationContext.runHttpApiWorkerProcess(
          secondPort,
          provider.code,
          apiKey,
        );
        const firstUrl = `http://127.0.0.1:${firstPort}`;
        const secondUrl = `http://127.0.0.1:${secondPort}`;
        const headers = {
          "content-type": "application/json",
          "x-provider-code": provider.code,
          "x-provider-key": apiKey,
        };
        const stopInstance = async (instance: ReturnType<typeof spawn>) => {
          if (instance.exitCode !== null || instance.signalCode !== null) {
            return;
          }
          const closed = new Promise<void>((resolve) =>
            instance.once("close", () => resolve()),
          );
          instance.kill("SIGTERM");
          await closed;
        };
        const triggerName = `multi_instance_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        const sequenceName = `${triggerName}_sequence`;
        let triggerCreated = false;
        try {
          await Promise.all([
            integrationContext.waitForHttpApi(
              `${firstUrl}/health/live`,
              firstInstance,
            ),
            integrationContext.waitForHttpApi(
              `${secondUrl}/health/live`,
              secondInstance,
            ),
          ]);

          const identicalBody = {
            playerId: context.playerId,
            walletId: context.walletId,
            externalTransactionId: `multi-instance-replay-${randomUUID()}`,
            kind: "BET",
            money: { amount: "10.00", currency: "BRL" },
          };
          const sharedIdempotencyKey = `multi-instance-key-${randomUUID()}`;
          const [firstReplayResponse, secondReplayResponse] = await Promise.all(
            [
              fetch(`${firstUrl}/wagering/transactions`, {
                method: "POST",
                headers: {
                  ...headers,
                  "idempotency-key": sharedIdempotencyKey,
                },
                body: JSON.stringify(identicalBody),
              }),
              fetch(`${secondUrl}/wagering/transactions`, {
                method: "POST",
                headers: {
                  ...headers,
                  "idempotency-key": sharedIdempotencyKey,
                },
                body: JSON.stringify(identicalBody),
              }),
            ],
          );
          expect([
            firstReplayResponse.status,
            secondReplayResponse.status,
          ]).toEqual([200, 200]);
          const [firstReplay, secondReplay] = await Promise.all([
            firstReplayResponse.json(),
            secondReplayResponse.json(),
          ]);
          // Same answer from both instances; exactly one of them did the work.
          expect({ ...firstReplay, idempotentReplay: null }).toEqual({
            ...secondReplay,
            idempotentReplay: null,
          });
          expect(
            [
              firstReplay.idempotentReplay,
              secondReplay.idempotentReplay,
            ].sort(),
          ).toEqual([false, true]);

          const contenders = await Promise.all([
            fetch(`${firstUrl}/wagering/transactions`, {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `multi-instance-contender-a-${randomUUID()}`,
              },
              body: JSON.stringify({
                playerId: context.playerId,
                walletId: context.walletId,
                externalTransactionId: `multi-instance-contender-a-${randomUUID()}`,
                kind: "BET",
                money: { amount: "60.00", currency: "BRL" },
              }),
            }),
            fetch(`${secondUrl}/wagering/transactions`, {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `multi-instance-contender-b-${randomUUID()}`,
              },
              body: JSON.stringify({
                playerId: context.playerId,
                walletId: context.walletId,
                externalTransactionId: `multi-instance-contender-b-${randomUUID()}`,
                kind: "BET",
                money: { amount: "60.00", currency: "BRL" },
              }),
            }),
          ]);
          expect(contenders.map((response) => response.status).sort()).toEqual([
            200, 422,
          ]);
          const contenderResults = await Promise.all(
            contenders.map(
              (response) =>
                response.json() as Promise<{
                  readonly status: string;
                  readonly failureCode: string | null;
                }>,
            ),
          );
          expect(
            contenderResults.map((result) => result.status).sort(),
          ).toEqual(["PROCESSED", "REJECTED"]);
          expect(
            contenderResults.find((result) => result.status === "REJECTED")
              ?.failureCode,
          ).toBe("INSUFFICIENT_FUNDS");
          const afterContention =
            await integrationContext.transactionManager.transaction((session) =>
              session.wallets.findById(context.walletId),
            );
          expect(afterContention?.balance).toBe("30.00");

          await integrationContext.orm.em.execute(
            `CREATE SEQUENCE "${integrationContext.schema}"."${sequenceName}" START WITH 1`,
          );
          await integrationContext.orm.em.execute(
            `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           IF nextval('"${integrationContext.schema}"."${sequenceName}"'::regclass) = 1 THEN
             PERFORM pg_sleep(3);
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

          const restartRequestBody = {
            playerId: context.playerId,
            walletId: context.walletId,
            externalTransactionId: `multi-instance-restart-${randomUUID()}`,
            kind: "WIN",
            money: { amount: "5.00", currency: "BRL" },
            // The WIN settles the replayed BET above.
            referenceExternalTransactionId: identicalBody.externalTransactionId,
          };
          const restartIdempotencyKey = `multi-instance-restart-key-${randomUUID()}`;
          const interruptedRequest = fetch(
            `${firstUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": restartIdempotencyKey,
              },
              body: JSON.stringify(restartRequestBody),
            },
          ).then(
            (response) => ({ response, error: null }),
            (error: unknown) => ({ response: null, error }),
          );

          let instancePausedInPostgres = false;
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
              instancePausedInPostgres = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(instancePausedInPostgres).toBe(true);

          const interruptedClose = new Promise<{
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }>((resolve) =>
            firstInstance.once("close", (code, signal) =>
              resolve({ code, signal }),
            ),
          );
          firstInstance.kill("SIGKILL");
          expect(await interruptedClose).toMatchObject({
            code: null,
            signal: "SIGKILL",
          });
          const interruptedResult = await interruptedRequest;
          expect(interruptedResult.response).toBeNull();
          expect(interruptedResult.error).toBeInstanceOf(Error);

          let activeSleepCount = "1";
          for (
            let attempt = 0;
            attempt < 400 && activeSleepCount !== "0";
            attempt += 1
          ) {
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
            activeSleepCount = activity[0]?.count ?? "0";
            if (activeSleepCount !== "0") {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          expect(activeSleepCount).toBe("0");

          const afterCrash = await integrationContext.orm.em.execute<
            {
              operation_count: string;
              wager_count: string;
              ledger_count: string;
              balance: string;
            }[]
          >(
            `SELECT
           (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS operation_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS wager_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = ? AND wager_transaction_id IN (
              SELECT id FROM "${integrationContext.schema}".wager_transactions
              WHERE provider_id = ? AND external_transaction_id = ?
            )) AS ledger_count,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance`,
            [
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.walletId,
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.walletId,
            ],
          );
          expect(afterCrash[0]).toEqual({
            operation_count: "0",
            wager_count: "0",
            ledger_count: "0",
            balance: "30.00",
          });

          const recoveredResponse = await fetch(
            `${secondUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": restartIdempotencyKey,
              },
              body: JSON.stringify(restartRequestBody),
            },
          );
          expect(recoveredResponse.status).toBe(200);
          expect(await recoveredResponse.json()).toMatchObject({
            externalTransactionId: restartRequestBody.externalTransactionId,
            status: "PROCESSED",
            balance: { amount: "35.00", currency: "BRL" },
          });

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
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS operation_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS wager_count,
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
              restartRequestBody.externalTransactionId,
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.walletId,
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.providerId,
              restartRequestBody.externalTransactionId,
              context.walletId,
            ],
          );
          expect(finalState[0]).toEqual({
            operation_count: "1",
            wager_count: "1",
            ledger_count: "1",
            outbox_count: "2",
            balance: "35.00",
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
          await stopInstance(firstInstance);
          await stopInstance(secondInstance);
        }
      }, 60_000);

      test("maps HTTP financial outcomes to persisted status, snapshots, and provider scope", async () => {
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
          undefined,
          {},
          { LOCALSTACK_ENDPOINT: "http://127.0.0.1:1" },
        );
        const baseUrl = `http://127.0.0.1:${port}`;
        const headers = {
          "content-type": "application/json",
          "x-provider-code": provider.code,
          "x-provider-key": apiKey,
        };
        const submit = (
          kind: "BET" | "REFUND",
          idempotencyKey: string,
          externalTransactionId: string,
          amount: string,
          identity: { playerId?: string; walletId?: string } = {},
          referenceExternalTransactionId?: string,
        ) =>
          fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: { ...headers, "idempotency-key": idempotencyKey },
            body: JSON.stringify({
              playerId: identity.playerId ?? context.playerId,
              walletId: identity.walletId ?? context.walletId,
              externalTransactionId,
              kind,
              money: { amount, currency: "BRL" },
              ...(referenceExternalTransactionId === undefined
                ? {}
                : { referenceExternalTransactionId }),
            }),
          });
        const statusOf = (externalTransactionId: string) =>
          fetch(
            `${baseUrl}/providers/${context.providerId}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
            { headers },
          );

        const triggerName = `http_internal_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        let triggerCreated = false;
        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          const unauthorized = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              ...headers,
              "x-provider-key": `${apiKey}-wrong`,
              "idempotency-key": `unauthorized-${randomUUID()}`,
            },
            body: JSON.stringify({
              playerId: context.playerId,
              walletId: context.walletId,
              externalTransactionId: `unauthorized-${randomUUID()}`,
              kind: "BET",
              money: { amount: "1.00", currency: "BRL" },
            }),
          });
          expect(unauthorized.status).toBe(401);
          expect(await unauthorized.json()).toMatchObject({
            statusCode: 401,
            code: "PROVIDER_AUTHENTICATION_FAILED",
          });

          const missingPlayerTransactionId = `missing-player-tx-${randomUUID()}`;
          const missingPlayerResponse = await submit(
            "BET",
            `missing-player-key-${randomUUID()}`,
            missingPlayerTransactionId,
            "1.00",
            { playerId: randomUUID() },
          );
          expect(missingPlayerResponse.status).toBe(422);
          const missingPlayerBody = await missingPlayerResponse.json();
          expect(missingPlayerBody).toMatchObject({
            externalTransactionId: missingPlayerTransactionId,
            status: "REJECTED",
            transactionId: null,
            balance: null,
            failureCode: "PLAYER_NOT_FOUND",
          });
          // Rejected before any transaction existed, yet queryable on the
          // contract's route by external ID.
          const missingPlayerStatus = await statusOf(
            missingPlayerTransactionId,
          );
          expect(missingPlayerStatus.status).toBe(200);
          expect(await missingPlayerStatus.json()).toMatchObject({
            transactionId: null,
            externalTransactionId: missingPlayerTransactionId,
            status: "REJECTED",
            failureCode: "PLAYER_NOT_FOUND",
          });

          const missingWalletTransactionId = `missing-wallet-${randomUUID()}`;
          const missingWalletResponse = await submit(
            "BET",
            `missing-wallet-key-${randomUUID()}`,
            missingWalletTransactionId,
            "1.00",
            { walletId: randomUUID() },
          );
          expect(missingWalletResponse.status).toBe(422);
          expect(await missingWalletResponse.json()).toMatchObject({
            externalTransactionId: missingWalletTransactionId,
            status: "REJECTED",
            transactionId: null,
            balance: null,
            failureCode: "WALLET_NOT_FOUND",
          });
          expect(
            await (await statusOf(missingWalletTransactionId)).json(),
          ).toMatchObject({
            status: "REJECTED",
            failureCode: "WALLET_NOT_FOUND",
          });
          expect((await statusOf(`never-sent-${randomUUID()}`)).status).toBe(
            404,
          );

          const targetId = `http-reversal-target-${randomUUID()}`;
          const targetResponse = await submit(
            "BET",
            `http-target-key-${randomUUID()}`,
            targetId,
            "10.00",
          );
          expect(targetResponse.status).toBe(200);

          const firstRefundId = `http-first-refund-${randomUUID()}`;
          const firstRefundResponse = await submit(
            "REFUND",
            `http-first-refund-key-${randomUUID()}`,
            firstRefundId,
            "10.00",
            {},
            targetId,
          );
          expect(firstRefundResponse.status).toBe(200);

          const duplicateRefundId = `http-duplicate-refund-${randomUUID()}`;
          const duplicateRefundResponse = await submit(
            "REFUND",
            `http-duplicate-refund-key-${randomUUID()}`,
            duplicateRefundId,
            "10.00",
            {},
            targetId,
          );
          expect(duplicateRefundResponse.status).toBe(422);
          const duplicateRefundBody = await duplicateRefundResponse.json();
          expect(duplicateRefundBody).toMatchObject({
            externalTransactionId: duplicateRefundId,
            status: "REJECTED",
            // The first REFUND is the BET's result; a second one conflicts.
            failureCode: "REFERENCE_ALREADY_SETTLED",
            balance: { amount: "50.00", currency: "BRL" },
          });
          expect(duplicateRefundBody.transactionId).toEqual(expect.any(String));
          const duplicateRefundStatus = await statusOf(duplicateRefundId);
          expect(await duplicateRefundStatus.json()).toMatchObject({
            transactionId: duplicateRefundBody.transactionId,
            status: "REJECTED",
            failureCode: "REFERENCE_ALREADY_SETTLED",
          });
          const duplicateSnapshot = await integrationContext.orm.em.execute<
            {
              response_http_status: number;
              response_snapshot: unknown;
            }[]
          >(
            `SELECT response_http_status, response_snapshot
         FROM "${integrationContext.schema}".financial_operations
         WHERE provider_id = ? AND external_transaction_id = ?`,
            [context.providerId, duplicateRefundId],
          );
          expect(duplicateSnapshot[0]).toMatchObject({
            response_http_status: 422,
            response_snapshot: {
              status: "REJECTED",
              failureCode: "REFERENCE_ALREADY_SETTLED",
              transaction: { id: duplicateRefundBody.transactionId },
              wallet: { balance: "50.00" },
            },
          });

          await integrationContext.orm.em.execute(
            `CREATE FUNCTION "${integrationContext.schema}"."${functionName}"() RETURNS trigger
         LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'injected internal database detail'
             USING ERRCODE = 'P0001';
         END;
         $$`,
          );
          await integrationContext.orm.em.execute(
            `CREATE TRIGGER "${triggerName}"
         BEFORE INSERT ON "${integrationContext.schema}".outbox
         FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          triggerCreated = true;
          const internalErrorId = `http-internal-${randomUUID()}`;
          const internalError = await submit(
            "BET",
            `http-internal-key-${randomUUID()}`,
            internalErrorId,
            "1.00",
          );
          expect(internalError.status).toBe(500);
          const internalErrorBody = await internalError.json();
          expect(internalErrorBody).toEqual({
            statusCode: 500,
            error: "InternalServerError",
            code: "INTERNAL_SERVER_ERROR",
            message: "An unexpected error occurred",
          });
          expect(JSON.stringify(internalErrorBody)).not.toContain(
            "injected internal database detail",
          );
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".outbox`,
          );
          triggerCreated = false;
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );

          const finalState = await integrationContext.orm.em.execute<
            {
              balance: string;
              reversal_count: string;
              duplicate_refund_ledger_count: string;
              outbox_event_count: string;
              internal_operation_count: string;
              internal_wager_count: string;
            }[]
          >(
            `SELECT wallet.balance::text AS balance,
                (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
                 WHERE provider_id = ? AND external_reference_transaction_id = ?
                   AND kind = 'REFUND' AND status = 'PROCESSED') AS reversal_count,
                (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
                 WHERE wager_transaction_id IN (
                   SELECT id FROM "${integrationContext.schema}".wager_transactions
                   WHERE provider_id = ? AND external_transaction_id = ?
                 )) AS duplicate_refund_ledger_count,
                (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
                 WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') IN (
                   SELECT id::text FROM "${integrationContext.schema}".wager_transactions
                   WHERE provider_id = ? AND external_transaction_id IN (?, ?, ?)
                 )) AS outbox_event_count,
                (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
                 WHERE provider_id = ? AND external_transaction_id = ?)
                   AS internal_operation_count,
                (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
                 WHERE provider_id = ? AND external_transaction_id = ?)
                   AS internal_wager_count
         FROM "${integrationContext.schema}".wallets wallet WHERE wallet.id = ?`,
            [
              context.providerId,
              targetId,
              context.providerId,
              duplicateRefundId,
              context.providerId,
              targetId,
              firstRefundId,
              duplicateRefundId,
              context.providerId,
              internalErrorId,
              context.providerId,
              internalErrorId,
              context.walletId,
            ],
          );
          expect(finalState[0]).toEqual({
            balance: "50.00",
            reversal_count: "1",
            duplicate_refund_ledger_count: "0",
            outbox_event_count: "5",
            internal_operation_count: "0",
            internal_wager_count: "0",
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
          if (apiWorker.exitCode === null && apiWorker.signalCode === null) {
            const stopped = new Promise<void>((resolve) =>
              apiWorker.once("close", () => resolve()),
            );
            apiWorker.kill("SIGTERM");
            await stopped;
          }
        }
      }, 30_000);
    });
  },
);
