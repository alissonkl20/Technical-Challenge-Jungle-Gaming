import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WagerTransactionKind } from "../../../src/modules/finance/domain/index.js";
import { OutboxService } from "../../../src/modules/outbox/outbox.service.js";
import type { OutboxMessage } from "../../../src/modules/outbox/types/index.js";
import { WagerCompensationService } from "../../../src/modules/transactions/wager-compensation.service.js";
import { WagerTransactionsService } from "../../../src/modules/transactions/wager-transactions.service.js";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";

/**
 * Failure after COMMIT: the wager is committed, publishing its events fails.
 * Recovery retries with a limit; once exhausted, a compensating ROLLBACK is
 * committed as a new financial operation. Everything below runs on real
 * PostgreSQL; the only stand-in is the SQS publisher, replaced by one that
 * fails on demand for the wager under test.
 */
const MAX_ATTEMPTS = 6;

registerPostgresIntegrationSuite(
  "post-commit recovery and compensation",
  (ctx) => {
    /** Publisher that fails for the given aggregates while `failing` is true. */
    function flakyPublisher(targets: Set<string>) {
      const state = { failing: true, published: [] as string[] };
      return {
        state,
        publisher: {
          publish: async (message: OutboxMessage) => {
            const payload = message.payload as {
              data?: Record<string, unknown>;
            };
            const transactionId = payload.data?.transactionId;
            const hit =
              targets.has(message.aggregateId) ||
              (typeof transactionId === "string" && targets.has(transactionId));
            if (hit && state.failing) {
              throw new Error("SQS unavailable (injected)");
            }
            state.published.push(message.eventId);
          },
        },
      };
    }

    function outbox(publisher: {
      publish: (m: OutboxMessage) => Promise<void>;
    }) {
      return new OutboxService(
        ctx.transactionManager,
        publisher,
        0,
        0,
        undefined,
        undefined,
        MAX_ATTEMPTS,
      );
    }

    async function dispatch(service: OutboxService, rounds: number) {
      for (let round = 0; round < rounds; round += 1) {
        await service.dispatchBatch(`test-worker-${randomUUID()}`, 500, 30_000);
      }
    }

    async function recoveryOf(wagerId: string) {
      return ctx.transactionManager.transaction((session) =>
        session.recoveries.findByWagerTransactionId(wagerId),
      );
    }

    async function balance(walletId: string): Promise<string | undefined> {
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(walletId),
      );
      return wallet?.balance;
    }

    async function ledgerOf(walletId: string) {
      return ctx.orm.em.execute<
        { kind: string; entry_type: string; amount: string; wager_id: string }[]
      >(
        `SELECT wager.kind, entry.entry_type, entry.amount::text AS amount,
              wager.id AS wager_id
         FROM "${ctx.schema}".wallet_ledger_entries entry
         JOIN "${ctx.schema}".wager_transactions wager
           ON wager.id = entry.wager_transaction_id
        WHERE entry.wallet_id = ? AND wager.kind <> 'OPENING'
        ORDER BY entry.created_at, entry.id`,
        [walletId],
      );
    }

    async function committedBet(amount = "10.00", balanceBefore = "100.00") {
      const c = await ctx.seedWagerContext(balanceBefore);
      const wagers = new WagerTransactionsService(ctx.transactionManager);
      const run = randomUUID();
      const bet = await wagers.process(
        c.providerId,
        `${run}-bet-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-bet`, {
          amount,
          roundId: "round-1",
        }),
      );
      expect(bet.response.status).toBe("PROCESSED");
      const betId = bet.response.transaction?.id ?? "";
      return { c, wagers, run, betId };
    }

    test("transient publication failure: recovery retries and completes without any financial effect", async () => {
      const { c, betId } = await committedBet();
      const { state, publisher } = flakyPublisher(new Set([betId]));
      const service = outbox(publisher);

      await dispatch(service, 2);
      const pending = await recoveryOf(betId);
      expect(pending?.status).toBe("PENDING_RECOVERY");
      expect(pending?.recovery_attempts).toBe(2);
      expect(pending?.last_error).toContain("injected");

      state.failing = false;
      await dispatch(service, 1);
      const recovered = await recoveryOf(betId);
      expect(recovered?.status).toBe("RECOVERED");
      expect(recovered?.compensation_transaction_id).toBeNull();
      expect(await balance(c.walletId)).toBe("90.00");
      expect(await ledgerOf(c.walletId)).toHaveLength(1);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("irrecoverable failure: compensation is a new ROLLBACK, the original stays intact, history proves every step", async () => {
      const { c, betId, run } = await committedBet();
      const { publisher } = flakyPublisher(new Set([betId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 2);

      const exhausted = await recoveryOf(betId);
      expect(exhausted?.status).toBe("COMPENSATION_REQUIRED");
      expect(exhausted?.recovery_attempts).toBe(MAX_ATTEMPTS);
      expect(exhausted?.exhausted_at).not.toBeNull();
      // Recovery stopped at its limit: the failed events keep their attempts.
      const events = await ctx.orm.em.execute<
        { status: string; attempts: number; last_error: string }[]
      >(
        `SELECT status, attempts, last_error FROM "${ctx.schema}".outbox
        WHERE aggregate_id = ? OR payload->'data'->>'transactionId' = ?`,
        [betId, betId],
      );
      expect(events.length).toBe(2);
      for (const event of events) {
        expect(event).toMatchObject({
          status: "FAILED",
          attempts: MAX_ATTEMPTS,
        });
      }
      expect(await balance(c.walletId)).toBe("90.00");

      const compensation = new WagerCompensationService(
        ctx.transactionManager,
        new WagerTransactionsService(ctx.transactionManager),
      );
      const pass = await compensation.compensateDue(50);
      expect(pass.resolved.COMPENSATED).toBeGreaterThanOrEqual(1);

      const resolved = await recoveryOf(betId);
      expect(resolved?.status).toBe("COMPENSATED");
      expect(await balance(c.walletId)).toBe("100.00");
      const original = await ctx.transactionManager.transaction((session) =>
        session.wagerTransactions.findById(betId),
      );
      expect(original?.status).toBe("PROCESSED");
      const compensating = await ctx.transactionManager.transaction((session) =>
        session.wagerTransactions.findById(
          resolved?.compensation_transaction_id ?? "",
        ),
      );
      expect(compensating).toMatchObject({
        kind: "ROLLBACK",
        status: "PROCESSED",
        reference_transaction_id: betId,
        external_transaction_id: `compensation:${run}-bet`,
        amount: "10.00",
      });
      // Original debit kept, compensating credit added: the effect is neutral.
      expect(
        (await ledgerOf(c.walletId)).map((row) => [
          row.kind,
          row.entry_type,
          row.amount,
        ]),
      ).toEqual([
        ["BET", "DEBIT", "10.00"],
        ["ROLLBACK", "CREDIT", "10.00"],
      ]);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);

      // A second pass, a replay of the compensation and a direct SQL attempt to
      // reopen the recovery all leave the money alone.
      expect(
        (await compensation.compensateDue(50)).resolved.COMPENSATED,
      ).toBeUndefined();
      const replay = await new WagerTransactionsService(
        ctx.transactionManager,
      ).process(c.providerId, `compensation:${betId}`, {
        externalPlayerId: c.externalPlayerId,
        externalTransactionId: `compensation:${run}-bet`,
        kind: WagerTransactionKind.ROLLBACK,
        amount: "10.00",
        currency: "BRL",
        externalReferenceTransactionId: `${run}-bet`,
        roundId: "round-1",
      });
      expect(replay.idempotentReplay).toBe(true);
      await expect(
        ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_recoveries
            SET status = 'COMPENSATION_REQUIRED', resolved_at = NULL,
                compensation_transaction_id = NULL
          WHERE wager_transaction_id = ?`,
          [betId],
        ),
      ).rejects.toThrow("not allowed");
      expect(await balance(c.walletId)).toBe("100.00");
    });

    test("three recovery workers in independent processes compensate the same wager exactly once", async () => {
      const { c, betId } = await committedBet();
      const { publisher } = flakyPublisher(new Set([betId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 1);
      expect((await recoveryOf(betId))?.status).toBe("COMPENSATION_REQUIRED");

      const startAt = Date.now() + 2_500;
      const outputs = await Promise.all(
        [1, 2, 3].map(
          () =>
            new Promise<{ pid: number }>((resolve, reject) => {
              const child = spawn(
                process.execPath,
                [
                  new URL(
                    "../../support/process-compensation.ts",
                    import.meta.url,
                  ).pathname,
                  String(startAt),
                ],
                {
                  cwd: process.cwd(),
                  env: { ...process.env, POSTGRES_SCHEMA: ctx.schema },
                  stdio: ["ignore", "pipe", "pipe"],
                },
              );
              let stdout = "";
              let stderr = "";
              child.stdout.setEncoding("utf8");
              child.stderr.setEncoding("utf8");
              child.stdout.on("data", (chunk: string) => {
                stdout += chunk;
              });
              child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
              });
              child.once("close", (code) => {
                if (code !== 0) {
                  reject(new Error(`worker exited ${code}: ${stderr}`));
                  return;
                }
                const line = stdout
                  .trim()
                  .split("\n")
                  .find((candidate) => candidate.startsWith('{"pid"'));
                resolve(JSON.parse(line ?? "{}"));
              });
            }),
        ),
      );
      expect(new Set(outputs.map((output) => output.pid)).size).toBe(3);

      expect((await recoveryOf(betId))?.status).toBe("COMPENSATED");
      expect(await balance(c.walletId)).toBe("100.00");
      const rollbacks = (await ledgerOf(c.walletId)).filter(
        (row) => row.kind === "ROLLBACK",
      );
      expect(rollbacks).toHaveLength(1);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 60_000);

    test("a failure during the compensation rolls it back entirely; the next attempt completes it; the limit ends in COMPENSATION_FAILED", async () => {
      const trigger = `fail_compensation_${randomUUID().replaceAll("-", "")}`;
      const { c, betId } = await committedBet();
      const { publisher } = flakyPublisher(new Set([betId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 1);

      // Fault injected inside the compensating transaction, after the wallet
      // update, at the Ledger insert of the ROLLBACK.
      await ctx.orm.em.execute(
        `CREATE FUNCTION "${ctx.schema}"."${trigger}"() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF (SELECT kind FROM "${ctx.schema}".wager_transactions
               WHERE id = NEW.wager_transaction_id) = 'ROLLBACK' THEN
           RAISE EXCEPTION 'injected failure during compensation';
         END IF;
         RETURN NEW;
       END;
       $$`,
      );
      await ctx.orm.em.execute(
        `CREATE TRIGGER "${trigger}" BEFORE INSERT
         ON "${ctx.schema}".wallet_ledger_entries
         FOR EACH ROW EXECUTE FUNCTION "${ctx.schema}"."${trigger}"()`,
      );
      const compensation = new WagerCompensationService(
        ctx.transactionManager,
        new WagerTransactionsService(ctx.transactionManager),
        undefined,
      );
      try {
        const failed = await compensation.compensateDue(50);
        expect(failed.deferred).toBeGreaterThanOrEqual(1);
        const deferred = await recoveryOf(betId);
        expect(deferred).toMatchObject({
          status: "COMPENSATION_REQUIRED",
          compensation_attempts: 1,
          compensation_transaction_id: null,
        });
        expect(deferred?.last_error).toContain("injected failure");
        // Nothing of the failed attempt survived: no ROLLBACK, no operation.
        expect(await balance(c.walletId)).toBe("90.00");
        const leftovers = await ctx.orm.em.execute<{ count: string }[]>(
          `SELECT count(*)::text AS count FROM "${ctx.schema}".financial_operations
          WHERE idempotency_key = ?`,
          [`compensation:${betId}`],
        );
        expect(leftovers[0]?.count).toBe("0");
      } finally {
        await ctx.orm.em.execute(
          `DROP TRIGGER "${trigger}" ON "${ctx.schema}".wallet_ledger_entries`,
        );
        await ctx.orm.em.execute(
          `DROP FUNCTION "${ctx.schema}"."${trigger}"()`,
        );
      }

      await ctx.orm.em.execute(
        `UPDATE "${ctx.schema}".wager_recoveries
          SET next_compensation_attempt_at = now()
        WHERE wager_transaction_id = ?`,
        [betId],
      );
      await compensation.compensateDue(50);
      expect((await recoveryOf(betId))?.status).toBe("COMPENSATED");
      expect(await balance(c.walletId)).toBe("100.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);

      // A compensation that never succeeds stops at its limit, auditable.
      const second = await committedBet();
      const flaky = flakyPublisher(new Set([second.betId]));
      await dispatch(outbox(flaky.publisher), MAX_ATTEMPTS + 1);
      const broken = new WagerCompensationService(
        ctx.transactionManager,
        {
          process: async () => {
            throw new Error("injected permanent failure");
          },
        } as unknown as WagerTransactionsService,
        { get: () => 2 } as never,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_recoveries
            SET next_compensation_attempt_at = now()
          WHERE wager_transaction_id = ? AND status = 'COMPENSATION_REQUIRED'`,
          [second.betId],
        );
        await broken.compensateDue(50);
      }
      expect(await recoveryOf(second.betId)).toMatchObject({
        status: "COMPENSATION_FAILED",
        failure_code: "COMPENSATION_EXHAUSTED",
        compensation_attempts: 2,
      });
      expect(await balance(second.c.walletId)).toBe("90.00");
    }, 30_000);

    test("nothing to neutralize: an already refunded BET and a LOSS end as COMPENSATION_NOT_REQUIRED without moving money", async () => {
      const { c, betId, run, wagers } = await committedBet();
      const loss = await wagers.process(
        c.providerId,
        `${run}-loss-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-loss`, {
          kind: WagerTransactionKind.LOSS,
          externalReferenceTransactionId: `${run}-bet`,
          roundId: "round-1",
        }),
      );
      const lossId = loss.response.transaction?.id ?? "";
      const other = await wagers.process(
        c.providerId,
        `${run}-bet2-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-bet2`, {
          amount: "10.00",
          roundId: "round-1",
        }),
      );
      const otherId = other.response.transaction?.id ?? "";
      await wagers.process(
        c.providerId,
        `${run}-refund-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-refund`, {
          kind: WagerTransactionKind.REFUND,
          externalReferenceTransactionId: `${run}-bet2`,
          roundId: "round-1",
        }),
      );
      expect(await balance(c.walletId)).toBe("90.00");

      const { publisher } = flakyPublisher(new Set([lossId, otherId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 1);
      await new WagerCompensationService(
        ctx.transactionManager,
        new WagerTransactionsService(ctx.transactionManager),
      ).compensateDue(50);

      expect(await recoveryOf(lossId)).toMatchObject({
        status: "COMPENSATION_NOT_REQUIRED",
        failure_code: "NO_FINANCIAL_EFFECT",
      });
      expect(await recoveryOf(otherId)).toMatchObject({
        status: "COMPENSATION_NOT_REQUIRED",
        failure_code: "REFERENCE_ALREADY_REVERSED",
      });
      expect(await recoveryOf(betId)).toBeNull();
      expect(await balance(c.walletId)).toBe("90.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("a WIN whose prize was spent cannot be compensated: explicit COMPENSATION_REJECTED, balance never negative", async () => {
      const { c, run, wagers } = await committedBet("10.00", "10.00");
      const win = await wagers.process(
        c.providerId,
        `${run}-win-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-win`, {
          kind: WagerTransactionKind.WIN,
          amount: "50.00",
          externalReferenceTransactionId: `${run}-bet`,
          roundId: "round-1",
        }),
      );
      const winId = win.response.transaction?.id ?? "";
      await wagers.process(
        c.providerId,
        `${run}-spend-key`,
        ctx.wagerInput(c.externalPlayerId, `${run}-spend`, { amount: "45.00" }),
      );
      expect(await balance(c.walletId)).toBe("5.00");

      const { publisher } = flakyPublisher(new Set([winId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 1);
      await new WagerCompensationService(
        ctx.transactionManager,
        new WagerTransactionsService(ctx.transactionManager),
      ).compensateDue(50);

      expect(await recoveryOf(winId)).toMatchObject({
        status: "COMPENSATION_REJECTED",
        failure_code: "REVERSAL_INSUFFICIENT_FUNDS",
      });
      expect(await balance(c.walletId)).toBe("5.00");
      const rejected = await ctx.orm.em.execute<{ status: string }[]>(
        `SELECT status FROM "${ctx.schema}".wager_transactions
        WHERE external_transaction_id = ?`,
        [`compensation:${run}-win`],
      );
      expect(rejected).toEqual([{ status: "REJECTED" }]);
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    });

    test("PostgreSQL refuses COMPENSATED without a processed compensating ROLLBACK, and a second recovery for one wager", async () => {
      const { betId } = await committedBet();
      const { publisher } = flakyPublisher(new Set([betId]));
      await dispatch(outbox(publisher), MAX_ATTEMPTS + 1);
      const recovery = await recoveryOf(betId);
      await expect(
        ctx.orm.em.execute(
          `UPDATE "${ctx.schema}".wager_recoveries
            SET status = 'COMPENSATED', resolved_at = now(),
                compensation_transaction_id = wager_transaction_id
          WHERE id = ?`,
          [recovery?.id],
        ),
      ).rejects.toThrow("requires a processed compensating ROLLBACK");
      await expect(
        ctx.orm.em.execute(
          `INSERT INTO "${ctx.schema}".wager_recoveries
           (wager_transaction_id, provider_id, wallet_id, status)
         SELECT wager_transaction_id, provider_id, wallet_id, 'PENDING_RECOVERY'
           FROM "${ctx.schema}".wager_recoveries WHERE id = ?`,
          [recovery?.id],
        ),
      ).rejects.toThrow("uq_wager_recoveries_wager");
      await expect(
        ctx.orm.em.execute(
          `DELETE FROM "${ctx.schema}".wager_recoveries WHERE id = ?`,
          [recovery?.id],
        ),
      ).rejects.toThrow("append-only");
    });
  },
);
