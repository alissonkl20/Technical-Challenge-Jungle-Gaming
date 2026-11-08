import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import { randomUUID } from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL HTTP API contract and validation",
  (integrationContext) => {
    describe("HTTP API contract and validation", () => {
      test("isolates providers on every contract route and no longer serves the removed /api/v1 routes", async () => {
        const context = await integrationContext.seedWagerContext("100.00");
        const provider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(context.providerId),
          );
        const other = await integrationContext.seedWagerContext("100.00");
        const otherProvider =
          await integrationContext.transactionManager.transaction((session) =>
            session.providers.findById(other.providerId),
          );
        if (provider === null || otherProvider === null) {
          throw new Error("Seeded providers were not persisted");
        }

        const apiKey = `${randomUUID()}-${randomUUID()}`;
        const otherApiKey = `${randomUUID()}-${randomUUID()}`;
        const port = await integrationContext.findAvailableHttpPort();
        const apiWorker = integrationContext.runHttpApiWorkerProcess(
          port,
          provider.code,
          apiKey,
          undefined,
          { [otherProvider.code]: otherApiKey },
        );
        const baseUrl = `http://127.0.0.1:${port}`;
        const own = {
          "content-type": "application/json",
          "x-provider-code": provider.code,
          "x-provider-key": apiKey,
        };
        const foreign = {
          "content-type": "application/json",
          "x-provider-code": otherProvider.code,
          "x-provider-key": otherApiKey,
        };

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

          const externalTransactionId = `isolation-bet-${randomUUID()}`;
          const betResponse = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: { ...own, "idempotency-key": `${randomUUID()}` },
            body: JSON.stringify({
              playerId: context.playerId,
              walletId: context.walletId,
              externalTransactionId,
              kind: "BET",
              money: { amount: "10.00", currency: "BRL" },
            }),
          });
          expect(betResponse.status).toBe(200);
          const bet = (await betResponse.json()) as { transactionId: string };

          // The other provider cannot read or reconcile anything of this one,
          // and cannot even learn whether it exists.
          for (const [method, path] of [
            ["GET", `/wallets/${context.walletId}`],
            ["GET", `/wallets/${context.walletId}/ledger`],
            ["POST", `/wallets/${context.walletId}/reconciliation`],
            ["GET", `/wagering/transactions/${bet.transactionId}`],
            [
              "GET",
              `/providers/${other.providerId}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
            ],
          ] as const) {
            const response = await fetch(`${baseUrl}${path}`, {
              method,
              headers: foreign,
            });
            expect([method, path, response.status]).toEqual([
              method,
              path,
              404,
            ]);
            const body = JSON.stringify(await response.json());
            expect(body).not.toContain(context.providerId);
            expect(body).not.toContain(context.playerId);
          }
          // Naming another provider in the route is a scope violation.
          expect(
            (
              await fetch(
                `${baseUrl}/providers/${context.providerId}/wagering/transactions/${encodeURIComponent(externalTransactionId)}`,
                { headers: foreign },
              )
            ).status,
          ).toBe(403);
          // Submitting with another provider's player and wallet moves nothing.
          const forged = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: { ...foreign, "idempotency-key": `${randomUUID()}` },
            body: JSON.stringify({
              playerId: context.playerId,
              walletId: context.walletId,
              externalTransactionId: `forged-${randomUUID()}`,
              kind: "BET",
              money: { amount: "10.00", currency: "BRL" },
            }),
          });
          expect(forged.status).toBe(422);
          expect(await forged.json()).toMatchObject({
            status: "REJECTED",
            failureCode: "PLAYER_NOT_FOUND",
            balance: null,
          });

          // The provider-facing surface is exactly the documented contract.
          for (const [method, path] of [
            ["POST", "/api/v1/transactions/bet"],
            ["POST", "/api/v1/wallets"],
            ["POST", "/api/v1/auth/provider"],
            ["GET", `/api/v1/players/${context.externalPlayerId}/wallets`],
            ["GET", `/api/v1/operations/${externalTransactionId}`],
            [
              "GET",
              `/providers/${context.providerId}/wallets/${context.walletId}`,
            ],
          ] as const) {
            const response = await fetch(`${baseUrl}${path}`, {
              method,
              headers: own,
              ...(method === "POST" ? { body: "{}" } : {}),
            });
            expect([method, path, response.status]).toEqual([
              method,
              path,
              404,
            ]);
          }

          for (const walletId of [context.walletId, other.walletId]) {
            const wallet =
              await integrationContext.transactionManager.transaction(
                (session) => session.wallets.findById(walletId),
              );
            expect(wallet?.balance).toBe(
              walletId === context.walletId ? "90.00" : "100.00",
            );
            await integrationContext.expectWalletBalanceMatchesLedger(walletId);
          }
        } finally {
          apiWorker.kill("SIGTERM");
        }
      });

      test("keeps liveness available and reports not ready when PostgreSQL is unreachable", async () => {
        const port = await integrationContext.findAvailableHttpPort();
        const unavailablePostgresPort =
          await integrationContext.findAvailableHttpPort();
        const apiWorker = integrationContext.runHttpApiWorkerProcess(
          port,
          `health-${randomUUID()}`,
          `${randomUUID()}-${randomUUID()}`,
          unavailablePostgresPort,
        );
        const baseUrl = `http://127.0.0.1:${port}`;

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          const liveResponse = await fetch(`${baseUrl}/health/live`);
          expect(liveResponse.status).toBe(200);
          expect(await liveResponse.json()).toEqual({ status: "ok" });

          const readinessResponse = await fetch(`${baseUrl}/health/ready`);
          expect(readinessResponse.status).toBe(503);
          expect(await readinessResponse.json()).toMatchObject({
            statusCode: 503,
            code: "DEPENDENCY_UNAVAILABLE",
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

      test("validates HTTP wager requests before persisting financial effects", async () => {
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
        const headers = {
          "content-type": "application/json",
          "x-provider-code": provider.code,
          "x-provider-key": apiKey,
        };

        try {
          await integrationContext.waitForHttpApi(
            `${baseUrl}/health/live`,
            apiWorker,
          );
          const validBody = (externalTransactionId: string) => ({
            playerId: context.playerId,
            walletId: context.walletId,
            externalTransactionId,
            kind: "BET",
            money: { amount: "1.00", currency: "BRL" },
          });
          const withMoney = (money: Record<string, unknown>) => ({
            money: { amount: "1.00", currency: "BRL", ...money },
          });
          const cases: readonly {
            readonly name: string;
            readonly body: unknown;
            readonly complete?: boolean;
            readonly status?: number;
          }[] = [
            { name: "empty object", body: {}, complete: true },
            {
              name: "incomplete object",
              body: { playerId: context.playerId },
              complete: true,
            },
            { name: "array instead of object", body: [], complete: true },
            {
              // providerId is part of the contract, but it must be the
              // authenticated provider: anything else is a scope violation.
              name: "forged provider identity",
              body: { providerId: randomUUID() },
              status: 403,
            },
            { name: "internal kind", body: { kind: "OPENING" } },
            { name: "unknown kind", body: { kind: "JACKPOT" } },
            {
              name: "caller-supplied timestamp",
              body: { createdAt: "invalid" },
            },
            { name: "numeric player identifier", body: { playerId: 42 } },
            { name: "empty player identifier", body: { playerId: "" } },
            { name: "blank wallet identifier", body: { walletId: "   " } },
            {
              name: "numeric transaction identifier",
              body: { externalTransactionId: 42 },
            },
            {
              name: "empty transaction identifier",
              body: { externalTransactionId: "" },
            },
            { name: "money as a string", body: { money: "1.00" } },
            { name: "numeric amount", body: withMoney({ amount: 1.25 }) },
            { name: "negative amount", body: withMoney({ amount: "-1.00" }) },
            { name: "zero amount", body: withMoney({ amount: "0.00" }) },
            {
              name: "excess decimal precision",
              body: withMoney({ amount: "1.001" }),
            },
            { name: "scientific notation", body: withMoney({ amount: "1e2" }) },
            { name: "NaN amount", body: withMoney({ amount: "NaN" }) },
            {
              name: "infinite amount",
              body: withMoney({ amount: "Infinity" }),
            },
            {
              name: "amount above NUMERIC(20,2)",
              body: withMoney({ amount: "1000000000000000000.00" }),
            },
            {
              name: "lowercase currency",
              body: withMoney({ currency: "brl" }),
            },
            { name: "short currency", body: withMoney({ currency: "BR" }) },
            { name: "numeric currency", body: withMoney({ currency: 123 }) },
            {
              name: "unknown money field",
              body: withMoney({ scale: 2 }),
            },
            {
              name: "oversized transaction identifier",
              body: { externalTransactionId: "t".repeat(201) },
            },
            {
              name: "null optional reference",
              body: { referenceExternalTransactionId: null },
            },
            {
              name: "REFUND without its reference",
              body: { kind: "REFUND" },
            },
            {
              name: "BET with a reference",
              body: { referenceExternalTransactionId: "some-bet" },
            },
          ];

          for (const [index, invalidCase] of cases.entries()) {
            const requestBody: unknown = invalidCase.complete
              ? invalidCase.body
              : {
                  ...validBody(`invalid-request-${randomUUID()}`),
                  ...(invalidCase.body as Record<string, unknown>),
                };
            const response = await fetch(`${baseUrl}/wagering/transactions`, {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `invalid-request-${index}-${randomUUID()}`,
              },
              body: JSON.stringify(requestBody),
            });
            const expected = invalidCase.status ?? 400;
            expect(response.status, invalidCase.name).toBe(expected);
            expect(await response.json(), invalidCase.name).toMatchObject({
              statusCode: expected,
            });
          }

          const missingKeyResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(validBody(`missing-key-${randomUUID()}`)),
            },
          );
          expect(missingKeyResponse.status).toBe(400);
          expect(await missingKeyResponse.json()).toMatchObject({
            code: "IDEMPOTENCY_KEY_REQUIRED",
          });

          const invalidCredentialsResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "x-provider-key": `${apiKey}-invalid`,
                "idempotency-key": `invalid-credentials-${randomUUID()}`,
              },
              body: JSON.stringify(
                validBody(`invalid-credentials-${randomUUID()}`),
              ),
            },
          );
          expect(invalidCredentialsResponse.status).toBe(401);

          const oversizedIdempotencyKeyResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": "k".repeat(201),
              },
              body: JSON.stringify(
                validBody(`oversized-idempotency-${randomUUID()}`),
              ),
            },
          );
          expect(oversizedIdempotencyKeyResponse.status).toBe(400);

          const malformedJsonResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `malformed-json-${randomUUID()}`,
              },
              body: '{"playerId":',
            },
          );
          expect(malformedJsonResponse.status).toBe(400);

          const oversizedBodyResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `oversized-body-${randomUUID()}`,
              },
              body: JSON.stringify({
                ...validBody(`oversized-${randomUUID()}`),
                padding: "x".repeat(110 * 1024),
              }),
            },
          );
          expect(oversizedBodyResponse.status).toBe(413);
          expect(await oversizedBodyResponse.json()).toMatchObject({
            statusCode: 413,
            code: "REQUEST_TOO_LARGE",
          });

          const validTransactionId = `validation:'";雪-${randomUUID()}`;
          const validResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `valid-special-characters-${randomUUID()}`,
              },
              body: JSON.stringify({
                ...validBody(validTransactionId),
                money: { amount: "1.20", currency: "BRL" },
                roundId: "round:';雪",
              }),
            },
          );
          expect(validResponse.status).toBe(200);
          expect(await validResponse.json()).toMatchObject({
            externalTransactionId: validTransactionId,
            status: "PROCESSED",
            balance: { amount: "48.80", currency: "BRL" },
            idempotentReplay: false,
          });

          const pendingReferenceId = `missing-reference-${randomUUID()}`;
          const pendingResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            {
              method: "POST",
              headers: {
                ...headers,
                "idempotency-key": `pending-reference-${randomUUID()}`,
              },
              body: JSON.stringify({
                ...validBody(`pending-refund-${randomUUID()}`),
                kind: "REFUND",
                referenceExternalTransactionId: pendingReferenceId,
              }),
            },
          );
          expect(pendingResponse.status).toBe(202);
          const pendingResult = (await pendingResponse.json()) as {
            readonly status: string;
            readonly transactionId: string | null;
          };
          expect(pendingResult).toMatchObject({
            status: "PENDING_REFERENCE",
          });
          if (pendingResult.transactionId === null) {
            throw new Error("Pending refund did not return its transaction ID");
          }
          await integrationContext.orm.em.execute(
            `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now() + interval '1 hour'
         WHERE id = ?`,
            [pendingResult.transactionId],
          );

          const persisted = await integrationContext.orm.em.execute<
            {
              operation_count: string;
              wager_count: string;
              ledger_count: string;
              processed_amount: string;
              processed_ledger_amount: string;
              balance: string;
              version: number;
            }[]
          >(
            `SELECT
           (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ?) AS operation_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ?) AS wager_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = ?) AS ledger_count,
           (SELECT amount::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS processed_amount,
           (SELECT entry.amount::text FROM "${integrationContext.schema}".wallet_ledger_entries entry
            JOIN "${integrationContext.schema}".wager_transactions wager
              ON wager.id = entry.wager_transaction_id
            WHERE wager.provider_id = ? AND wager.external_transaction_id = ?)
              AS processed_ledger_amount,
           (SELECT balance::text FROM "${integrationContext.schema}".wallets WHERE id = ?) AS balance,
           (SELECT version FROM "${integrationContext.schema}".wallets WHERE id = ?) AS version`,
            [
              context.providerId,
              context.providerId,
              context.walletId,
              context.providerId,
              validTransactionId,
              context.providerId,
              validTransactionId,
              context.walletId,
              context.walletId,
            ],
          );
          expect(persisted[0]).toEqual({
            operation_count: "2",
            wager_count: "3",
            ledger_count: "2",
            processed_amount: "1.20",
            processed_ledger_amount: "1.20",
            balance: "48.80",
            version: 3,
          });
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.walletId,
          );
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
    });
  },
);
