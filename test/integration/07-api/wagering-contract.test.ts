import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  PlayersService,
  randomUUID,
} from "../../support/postgres-test-dependencies.js";

interface SubmitResponse {
  readonly transactionId: string | null;
  readonly externalTransactionId: string;
  readonly status: string;
  readonly balance: {
    readonly amount: string;
    readonly currency: string;
  } | null;
  readonly failureCode: string | null;
  readonly idempotentReplay: boolean;
}

registerPostgresIntegrationSuite(
  "PostgreSQL published wagering contract",
  (integrationContext) => {
    describe("published wagering contract", () => {
      test("serves the documented wallet and wagering endpoints end to end", async () => {
        const context = await integrationContext.seedWagerContext("0.00");
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

          const player = await new PlayersService(
            integrationContext.transactionManager,
          ).register(context.providerId, {
            externalPlayerId: `contract-player-${randomUUID()}`,
          });

          // POST /wallets — the opening credit is part of the same SQL transaction.
          const openResponse = await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              playerId: player.id,
              initialBalance: { amount: "1000.00", currency: "BRL" },
            }),
          });
          expect(openResponse.status).toBe(201);
          const wallet = (await openResponse.json()) as {
            readonly id: string;
            readonly playerId: string;
            readonly balance: {
              readonly amount: string;
              readonly currency: string;
            };
            readonly version: number;
          };
          expect(wallet).toMatchObject({
            playerId: player.id,
            balance: { amount: "1000.00", currency: "BRL" },
            version: 1,
          });

          // Opening the same player and currency twice is a conflict.
          const duplicateResponse = await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              playerId: player.id,
              initialBalance: { amount: "10.00", currency: "BRL" },
            }),
          });
          expect(duplicateResponse.status).toBe(409);

          // POST /wagering/transactions — a BET debits the wallet.
          const externalTransactionId = `contract-bet-${randomUUID()}`;
          const idempotencyKey = `${provider.code}:${externalTransactionId}`;
          const submit = (
            body: Record<string, unknown>,
            key = idempotencyKey,
          ) =>
            fetch(`${baseUrl}/wagering/transactions`, {
              method: "POST",
              headers: { ...headers, "idempotency-key": key },
              body: JSON.stringify(body),
            });
          const betBody = {
            providerId: context.providerId,
            externalTransactionId,
            playerId: player.id,
            walletId: wallet.id,
            roundId: "round-987",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
          };

          const betResponse = await submit(betBody);
          expect(betResponse.status).toBe(200);
          const bet = (await betResponse.json()) as SubmitResponse;
          expect(bet).toMatchObject({
            externalTransactionId,
            status: "PROCESSED",
            balance: { amount: "975.00", currency: "BRL" },
            idempotentReplay: false,
          });
          expect(bet.transactionId).toEqual(expect.any(String));

          // An identical retry replays the stored result and is flagged.
          const replayResponse = await submit(betBody);
          expect(replayResponse.status).toBe(200);
          expect(await replayResponse.json()).toEqual({
            ...bet,
            idempotentReplay: true,
          });

          // The same key with a different payload is a conflict, not a replay.
          const conflictResponse = await submit({
            ...betBody,
            money: { amount: "26.00", currency: "BRL" },
          });
          expect(conflictResponse.status).toBe(409);
          expect(await conflictResponse.json()).toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
          });

          // A missing Idempotency-Key is an invalid request.
          const missingKeyResponse = await fetch(
            `${baseUrl}/wagering/transactions`,
            { method: "POST", headers, body: JSON.stringify(betBody) },
          );
          expect(missingKeyResponse.status).toBe(400);
          expect(await missingKeyResponse.json()).toMatchObject({
            code: "IDEMPOTENCY_KEY_REQUIRED",
          });

          // OPENING can never be submitted through the API.
          const openingResponse = await submit(
            { ...betBody, kind: "OPENING" },
            `contract-opening-${randomUUID()}`,
          );
          expect(openingResponse.status).toBe(400);
          expect(await openingResponse.json()).toMatchObject({
            code: "INVALID_PAYLOAD",
          });

          // A business rejection is distinguishable from a conflict.
          const insufficientResponse = await submit(
            {
              ...betBody,
              externalTransactionId: `contract-overdraw-${randomUUID()}`,
              money: { amount: "100000.00", currency: "BRL" },
            },
            `contract-overdraw-key-${randomUUID()}`,
          );
          expect(insufficientResponse.status).toBe(422);
          expect(await insufficientResponse.json()).toMatchObject({
            status: "REJECTED",
            failureCode: "INSUFFICIENT_FUNDS",
          });

          // REFUND arriving before its reference is accepted as pending.
          const pendingResponse = await submit(
            {
              ...betBody,
              externalTransactionId: `contract-early-refund-${randomUUID()}`,
              kind: "REFUND",
              referenceExternalTransactionId: `contract-absent-${randomUUID()}`,
            },
            `contract-early-refund-key-${randomUUID()}`,
          );
          expect(pendingResponse.status).toBe(202);
          expect(await pendingResponse.json()).toMatchObject({
            status: "PENDING_REFERENCE",
          });

          // A provider may identify itself by its registered code, exactly as
          // the published examples do, instead of by its UUID.
          const codeScopedExternalId = `contract-code-bet-${randomUUID()}`;
          const codeScopedResponse = await submit(
            {
              ...betBody,
              providerId: provider.code,
              externalTransactionId: codeScopedExternalId,
              money: { amount: "5.00", currency: "BRL" },
            },
            `${provider.code}:${codeScopedExternalId}`,
          );
          expect(codeScopedResponse.status).toBe(200);
          const codeScopedBet =
            (await codeScopedResponse.json()) as SubmitResponse;
          expect(codeScopedBet).toMatchObject({
            status: "PROCESSED",
            balance: { amount: "970.00", currency: "BRL" },
            idempotentReplay: false,
          });

          // The same holds for the provider-scoped read route.
          const byCodeResponse = await fetch(
            `${baseUrl}/providers/${encodeURIComponent(provider.code)}/wagering/transactions/${encodeURIComponent(
              codeScopedExternalId,
            )}`,
            { headers },
          );
          expect(byCodeResponse.status).toBe(200);
          expect(await byCodeResponse.json()).toMatchObject({
            transactionId: codeScopedBet.transactionId,
            externalTransactionId: codeScopedExternalId,
          });

          // An identifier belonging to neither identity is still out of scope.
          const foreignScopeResponse = await submit(
            {
              ...betBody,
              providerId: randomUUID(),
              externalTransactionId: `contract-foreign-${randomUUID()}`,
            },
            `contract-foreign-key-${randomUUID()}`,
          );
          expect(foreignScopeResponse.status).toBe(403);
          expect(await foreignScopeResponse.json()).toMatchObject({
            code: "PROVIDER_SCOPE_MISMATCH",
          });

          // GET /wallets/:walletId
          const walletResponse = await fetch(
            `${baseUrl}/wallets/${wallet.id}`,
            { headers },
          );
          expect(walletResponse.status).toBe(200);
          expect(await walletResponse.json()).toMatchObject({
            id: wallet.id,
            playerId: player.id,
            balance: { amount: "970.00", currency: "BRL" },
          });

          // GET /wallets/:walletId/ledger — opaque keyset cursor.
          const firstPageResponse = await fetch(
            `${baseUrl}/wallets/${wallet.id}/ledger?limit=1`,
            { headers },
          );
          expect(firstPageResponse.status).toBe(200);
          const firstPage = (await firstPageResponse.json()) as {
            readonly items: readonly {
              readonly transactionId: string;
              readonly direction: string;
              readonly money: { readonly amount: string };
              readonly balanceAfter: { readonly amount: string };
            }[];
            readonly nextCursor: string | null;
          };
          expect(firstPage.items).toHaveLength(1);
          expect(firstPage.items[0]).toMatchObject({
            transactionId: codeScopedBet.transactionId ?? "",
            direction: "DEBIT",
            money: { amount: "5.00", currency: "BRL" },
            balanceAfter: { amount: "970.00", currency: "BRL" },
          });
          expect(firstPage.nextCursor).toEqual(expect.any(String));

          const secondPageResponse = await fetch(
            `${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${encodeURIComponent(
              firstPage.nextCursor ?? "",
            )}`,
            { headers },
          );
          const secondPage = (await secondPageResponse.json()) as {
            readonly items: readonly {
              readonly transactionId: string;
              readonly direction: string;
            }[];
            readonly nextCursor: string | null;
          };
          expect(secondPage.items).toHaveLength(1);
          expect(secondPage.items[0]).toMatchObject({
            transactionId: bet.transactionId ?? "",
            direction: "DEBIT",
            money: { amount: "25.00", currency: "BRL" },
          });
          expect(secondPage.nextCursor).toEqual(expect.any(String));

          expect(
            (
              await fetch(
                `${baseUrl}/wallets/${wallet.id}/ledger?cursor=not-a-cursor`,
                { headers },
              )
            ).status,
          ).toBe(400);

          // GET /wagering/transactions/:transactionId
          const transactionResponse = await fetch(
            `${baseUrl}/wagering/transactions/${bet.transactionId ?? ""}`,
            { headers },
          );
          expect(transactionResponse.status).toBe(200);
          expect(await transactionResponse.json()).toMatchObject({
            transactionId: bet.transactionId,
            externalTransactionId,
            walletId: wallet.id,
            kind: "BET",
            status: "PROCESSED",
            money: { amount: "25.00", currency: "BRL" },
            roundId: "round-987",
            gameId: "fortune-chimp",
          });

          // GET /providers/:providerId/wagering/transactions/:externalTransactionId
          const byExternalIdResponse = await fetch(
            `${baseUrl}/providers/${context.providerId}/wagering/transactions/${encodeURIComponent(
              externalTransactionId,
            )}`,
            { headers },
          );
          expect(byExternalIdResponse.status).toBe(200);
          expect(await byExternalIdResponse.json()).toMatchObject({
            transactionId: bet.transactionId,
            externalTransactionId,
          });

          expect(
            (
              await fetch(
                `${baseUrl}/providers/${context.providerId}/wagering/transactions/${randomUUID()}`,
                { headers },
              )
            ).status,
          ).toBe(404);

          // POST /wallets/:walletId/reconciliation
          const reconciliationResponse = await fetch(
            `${baseUrl}/wallets/${wallet.id}/reconciliation`,
            { method: "POST", headers },
          );
          expect(reconciliationResponse.status).toBe(200);
          expect(await reconciliationResponse.json()).toMatchObject({
            walletId: wallet.id,
            storedBalance: { amount: "970.00", currency: "BRL" },
            calculatedBalance: { amount: "970.00", currency: "BRL" },
            difference: { amount: "0.00", currency: "BRL" },
            consistent: true,
            checkedEntries: 3,
          });

          // Unauthenticated access is refused; health stays open.
          expect((await fetch(`${baseUrl}/wallets/${wallet.id}`)).status).toBe(
            401,
          );
          expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);

          await integrationContext.expectWalletBalanceMatchesLedger(wallet.id);
        } finally {
          apiWorker.kill("SIGTERM");
        }
      }, 60_000);
    });
  },
);
