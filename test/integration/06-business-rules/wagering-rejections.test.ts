import { describe, expect, test } from "bun:test";
import { SubmitWagerService } from "../../../src/modules/finance/application/submit-wager.service.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  WagerTransactionKind,
  WagerTransactionsService,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL canonical wagering rejections",
  (ctx) => {
    describe("POST /wagering/transactions rejections are auditable and replayable", () => {
      function submitter() {
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        return new SubmitWagerService(ctx.transactionManager, wagers);
      }

      function command(
        playerId: string,
        walletId: string,
        externalTransactionId: string,
        currency = "BRL",
        amount = "10.00",
      ) {
        return {
          playerId,
          walletId,
          externalTransactionId,
          kind: WagerTransactionKind.BET,
          money: { amount, currency },
        };
      }

      async function balance(walletId: string): Promise<string | undefined> {
        const wallet = await ctx.transactionManager.transaction((session) =>
          session.wallets.findById(walletId),
        );
        return wallet?.balance;
      }

      test("unknown player: 422 REJECTED, recorded, and replayed under the same key", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const service = submitter();
        const missing = "00000000-0000-4000-8000-000000000001";
        const first = await service.submit(
          c.providerId,
          "rej-player-1",
          command(missing, c.walletId, "rej-p-1"),
        );
        expect(first.httpStatus).toBe(422);
        expect(first.status).toBe("REJECTED");
        expect(first.failureCode).toBe("PLAYER_NOT_FOUND");
        expect(first.balance).toBeNull();
        expect(first.idempotentReplay).toBe(false);

        const replay = await service.submit(
          c.providerId,
          "rej-player-1",
          command(missing, c.walletId, "rej-p-1"),
        );
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.httpStatus).toBe(422);
        expect(replay.failureCode).toBe("PLAYER_NOT_FOUND");
        expect(await balance(c.walletId)).toBe("100.00");
        await ctx.expectWalletBalanceMatchesLedger(c.walletId);
      });

      test("wallet of another player: WALLET_NOT_FOUND, no money moves", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const other = await ctx.seedWagerContext("50.00");
        const result = await submitter().submit(
          c.providerId,
          "rej-wallet-1",
          command(c.playerId, other.walletId, "rej-w-1"),
        );
        expect(result.httpStatus).toBe(422);
        expect(result.failureCode).toBe("WALLET_NOT_FOUND");
        expect(await balance(c.walletId)).toBe("100.00");
        expect(await balance(other.walletId)).toBe("50.00");
      });

      test("currency mismatch: CURRENCY_MISMATCH, recorded", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const result = await submitter().submit(
          c.providerId,
          "rej-currency-1",
          command(c.playerId, c.walletId, "rej-c-1", "USD"),
        );
        expect(result.httpStatus).toBe(422);
        expect(result.failureCode).toBe("CURRENCY_MISMATCH");
        expect(await balance(c.walletId)).toBe("100.00");
      });

      test("same key with a different payload is a conflict, even for a rejected operation", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const service = submitter();
        const missing = "00000000-0000-4000-8000-000000000002";
        await service.submit(
          c.providerId,
          "rej-conflict-1",
          command(missing, c.walletId, "rej-x-1"),
        );
        let message = "";
        try {
          await service.submit(
            c.providerId,
            "rej-conflict-1",
            command(missing, c.walletId, "rej-x-1", "BRL", "11.00"),
          );
        } catch (error) {
          message = String(error);
        }
        expect(message).toMatch(/Idempotency|conflict/i);
      });

      test("both endpoints give the same rejection for an unknown player", async () => {
        const c = await ctx.seedWagerContext("100.00");
        const missing = "00000000-0000-4000-8000-000000000003";
        const canonical = await submitter().submit(
          c.providerId,
          "eq-canon-1",
          command(missing, c.walletId, "eq-1"),
        );
        const wagers = new WagerTransactionsService(ctx.transactionManager);
        const alias = await wagers.process(
          c.providerId,
          "eq-alias-1",
          ctx.wagerInput("unknown-external-player", "eq-2"),
        );
        expect(canonical.httpStatus).toBe(alias.httpStatus);
        expect(canonical.status).toBe(alias.response.status);
        expect(canonical.failureCode).toBe(alias.response.failureCode);
      });
    });
  },
);
