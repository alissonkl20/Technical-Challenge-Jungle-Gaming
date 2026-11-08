import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { WagerTransactionKind } from "../src/modules/finance/domain/index.js";
import { PendingReferenceRetryService } from "../src/modules/transactions/pending-reference-retry.service.js";
import { PendingReferenceWorkerService } from "../src/modules/transactions/pending-reference-worker.service.js";
import { WagerTransactionsService } from "../src/modules/transactions/wager-transactions.service.js";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  type InstanceRequest,
  runAcrossInstances,
} from "./support/multi-instance.js";

/**
 * "The first valid result recorded atomically in PostgreSQL wins."
 *
 * A BET has one definitive result among WIN, LOSS and REFUND. A result that
 * arrives before its BET is recorded as PENDING_REFERENCE and already holds
 * the result, so conflicting results are refused whether the BET came first
 * or not. Concurrency tests run in three independent OS processes.
 */
registerPostgresIntegrationSuite("one definitive result per BET", (ctx) => {
  const STAKE = "10.00";
  const PRIZE = "50.00";

  function result(
    externalPlayerId: string,
    run: string,
    kind: WagerTransactionKind,
    bet = `${run}-bet`,
  ): InstanceRequest {
    const name = `${run}-${kind.toLowerCase()}`;
    return {
      idempotencyKey: `${name}-key`,
      wager: ctx.wagerInput(externalPlayerId, name, {
        kind,
        amount: kind === WagerTransactionKind.WIN ? PRIZE : STAKE,
        externalReferenceTransactionId: bet,
        roundId: "round-1",
      }),
    };
  }

  function betRequest(externalPlayerId: string, run: string): InstanceRequest {
    return {
      idempotencyKey: `${run}-bet-key`,
      wager: ctx.wagerInput(externalPlayerId, `${run}-bet`, {
        amount: STAKE,
        roundId: "round-1",
      }),
    };
  }

  /** Balance a BET of 10 plus `winner` imply, from an opening of 100. */
  function balanceAfter(winner: string): string {
    if (winner === "WIN") return "140.00";
    if (winner === "REFUND") return "100.00";
    return "90.00";
  }

  async function state(walletId: string, run: string) {
    const rows = await ctx.orm.em.execute<
      { kind: string; status: string; failure_code: string | null }[]
    >(
      `SELECT kind, status, failure_code FROM "${ctx.schema}".wager_transactions
        WHERE wallet_id = ? AND external_transaction_id LIKE ?
        ORDER BY kind`,
      [walletId, `${run}-%`],
    );
    const wallet = await ctx.transactionManager.transaction((session) =>
      session.wallets.findById(walletId),
    );
    const ledger = await ctx.orm.em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM "${ctx.schema}".wallet_ledger_entries entry
         JOIN "${ctx.schema}".wager_transactions wager
           ON wager.id = entry.wager_transaction_id
        WHERE entry.wallet_id = ? AND wager.kind <> 'OPENING'`,
      [walletId],
    );
    const events = await ctx.orm.em.execute<
      { event_type: string; count: string }[]
    >(
      `SELECT event_type, count(*)::text AS count FROM "${ctx.schema}".outbox
        WHERE payload->'data'->>'externalTransactionId' LIKE ?
           OR aggregate_id IN (
             SELECT id FROM "${ctx.schema}".wager_transactions
              WHERE external_transaction_id LIKE ?)
        GROUP BY event_type ORDER BY event_type`,
      [`${run}-%`, `${run}-%`],
    );
    await ctx.expectWalletBalanceMatchesLedger(walletId);
    return {
      results: rows.filter((row) => row.kind !== "BET"),
      balance: wallet?.balance,
      ledgerEntries: Number(ledger[0]?.count),
      events: Object.fromEntries(
        events.map((row) => [row.event_type, Number(row.count)]),
      ),
    };
  }

  async function drainPending(walletId: string): Promise<void> {
    const service = new WagerTransactionsService(ctx.transactionManager);
    const worker = new PendingReferenceWorkerService(
      ctx.transactionManager,
      new PendingReferenceRetryService(ctx.transactionManager, service),
      new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
    );
    await ctx.orm.em.execute(
      `UPDATE "${ctx.schema}".wager_transactions
          SET next_reference_attempt_at = now()
        WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'`,
      [walletId],
    );
    await worker.processDue(100);
  }

  /** Exactly one result PROCESSED, every other result REJECTED as settled. */
  function expectOneWinner(
    results: { kind: string; status: string; failure_code: string | null }[],
  ): string {
    const processed = results.filter((row) => row.status === "PROCESSED");
    expect(processed).toHaveLength(1);
    const losers = results.filter((row) => row.status !== "PROCESSED");
    expect(losers.length).toBeGreaterThan(0);
    for (const loser of losers) {
      expect(loser).toMatchObject({
        status: "REJECTED",
        failure_code: "REFERENCE_ALREADY_SETTLED",
      });
    }
    return processed[0]?.kind ?? "";
  }

  for (const kinds of [
    [WagerTransactionKind.WIN, WagerTransactionKind.REFUND],
    [WagerTransactionKind.LOSS, WagerTransactionKind.WIN],
    [
      WagerTransactionKind.WIN,
      WagerTransactionKind.LOSS,
      WagerTransactionKind.REFUND,
    ],
  ]) {
    test(`BET first, then ${kinds.join(" x ")} simultaneously from 3 processes (each redelivered): one result wins`, async () => {
      const c = await ctx.seedWagerContext("100.00");
      const run = randomUUID();
      const service = new WagerTransactionsService(ctx.transactionManager);
      const bet = betRequest(c.externalPlayerId, run);
      expect(
        (await service.process(c.providerId, bet.idempotencyKey, bet.wager))
          .response.status,
      ).toBe("PROCESSED");

      const contenders = kinds.map((kind) =>
        result(c.externalPlayerId, run, kind),
      );
      // Every contender is sent by every instance: competition + redelivery.
      const requests = [...contenders, ...contenders, ...contenders];
      const answers = await runAcrossInstances(
        ctx.schema,
        c.providerId,
        requests,
      );
      expect(answers.filter((answer) => answer.error !== null)).toEqual([]);

      const outcome = await state(c.walletId, run);
      expect(outcome.results).toHaveLength(kinds.length);
      const winner = expectOneWinner(outcome.results);
      expect(outcome.balance).toBe(balanceAfter(winner));
      // BET debit, plus a credit unless the winner was the LOSS.
      expect(outcome.ledgerEntries).toBe(winner === "LOSS" ? 1 : 2);
      expect(outcome.events.WagerTransactionProcessed).toBe(2);
      expect(outcome.events.WagerTransactionRejected).toBe(kinds.length - 1);
      // Every instance saw the same answer for the same external ID.
      for (const contender of contenders) {
        const seen = answers.filter(
          (answer) =>
            answer.request.wager.externalTransactionId ===
            contender.wager.externalTransactionId,
        );
        expect(new Set(seen.map((answer) => answer.status)).size).toBe(1);
      }
    }, 60_000);
  }

  test("results before the BET: three processes race to reserve, one reservation wins and is applied when the BET arrives", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const run = randomUUID();
    const contenders = [
      WagerTransactionKind.WIN,
      WagerTransactionKind.LOSS,
      WagerTransactionKind.REFUND,
    ].map((kind) => result(c.externalPlayerId, run, kind));
    const answers = await runAcrossInstances(ctx.schema, c.providerId, [
      ...contenders,
      ...contenders,
    ]);
    expect(answers.filter((answer) => answer.error !== null)).toEqual([]);

    const reserved = await state(c.walletId, run);
    expect(
      reserved.results.filter((row) => row.status === "PENDING_REFERENCE"),
    ).toHaveLength(1);
    expect(
      reserved.results.filter(
        (row) =>
          row.status === "REJECTED" &&
          row.failure_code === "REFERENCE_ALREADY_SETTLED",
      ),
    ).toHaveLength(2);
    expect(reserved.balance).toBe("100.00");
    expect(reserved.ledgerEntries).toBe(0);
    const reservedKind = reserved.results.find(
      (row) => row.status === "PENDING_REFERENCE",
    )?.kind;

    const service = new WagerTransactionsService(ctx.transactionManager);
    const bet = betRequest(c.externalPlayerId, run);
    await service.process(c.providerId, bet.idempotencyKey, bet.wager);
    await drainPending(c.walletId);

    const applied = await state(c.walletId, run);
    const winner = expectOneWinner(applied.results);
    expect(winner).toBe(reservedKind ?? "");
    expect(applied.balance).toBe(balanceAfter(winner));

    // A result arriving after everything is settled is refused too.
    for (const contender of contenders) {
      const replay = await service.process(
        c.providerId,
        contender.idempotencyKey,
        contender.wager,
      );
      expect(replay.idempotentReplay).toBe(true);
    }
    const late = await service.process(
      c.providerId,
      `${run}-late-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-late`, {
        kind: WagerTransactionKind.WIN,
        amount: "999.00",
        externalReferenceTransactionId: `${run}-bet`,
        roundId: "round-1",
      }),
    );
    expect(late.response.failureCode).toBe("REFERENCE_ALREADY_SETTLED");
    expect((await state(c.walletId, run)).balance).toBe(balanceAfter(winner));
  }, 60_000);

  test("an invalid result never reserves the BET: a REFUND of the wrong amount is refused and a WIN still wins", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const run = randomUUID();
    const service = new WagerTransactionsService(ctx.transactionManager);
    const bet = betRequest(c.externalPlayerId, run);
    await service.process(c.providerId, bet.idempotencyKey, bet.wager);

    const partialRefund = await service.process(
      c.providerId,
      `${run}-partial-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-partial`, {
        kind: WagerTransactionKind.REFUND,
        amount: "3.00",
        externalReferenceTransactionId: `${run}-bet`,
        roundId: "round-1",
      }),
    );
    expect(partialRefund.response.failureCode).toBe(
      "REFERENCE_AMOUNT_MISMATCH",
    );
    const wrongRound = await service.process(
      c.providerId,
      `${run}-round-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-round`, {
        kind: WagerTransactionKind.LOSS,
        externalReferenceTransactionId: `${run}-bet`,
        roundId: "round-2",
      }),
    );
    expect(wrongRound.response.failureCode).toBe("REFERENCE_ROUND_MISMATCH");

    const win = result(c.externalPlayerId, run, WagerTransactionKind.WIN);
    const applied = await service.process(
      c.providerId,
      win.idempotencyKey,
      win.wager,
    );
    expect(applied.response.status).toBe("PROCESSED");
    expect((await state(c.walletId, run)).balance).toBe("140.00");
  });

  test("a WIN reversed by ROLLBACK releases the result (established corrected-WIN rule)", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const run = randomUUID();
    const service = new WagerTransactionsService(ctx.transactionManager);
    const bet = betRequest(c.externalPlayerId, run);
    await service.process(c.providerId, bet.idempotencyKey, bet.wager);
    const win = result(c.externalPlayerId, run, WagerTransactionKind.WIN);
    await service.process(c.providerId, win.idempotencyKey, win.wager);
    await service.process(
      c.providerId,
      `${run}-rollback-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-rollback`, {
        kind: WagerTransactionKind.ROLLBACK,
        amount: PRIZE,
        externalReferenceTransactionId: win.wager.externalTransactionId,
        roundId: "round-1",
      }),
    );
    const loss = result(c.externalPlayerId, run, WagerTransactionKind.LOSS);
    const corrected = await service.process(
      c.providerId,
      loss.idempotencyKey,
      loss.wager,
    );
    expect(corrected.response.status).toBe("PROCESSED");
    expect((await state(c.walletId, run)).balance).toBe("90.00");
  });

  test("contract: WIN and LOSS without a reference are recorded on their own and never take a BET's result", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const run = randomUUID();
    const service = new WagerTransactionsService(ctx.transactionManager);
    const bet = betRequest(c.externalPlayerId, run);
    await service.process(c.providerId, bet.idempotencyKey, bet.wager);

    const credit = await service.process(
      c.providerId,
      `${run}-free-win-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-free-win`, {
        kind: WagerTransactionKind.WIN,
        amount: "7.00",
      }),
    );
    expect(credit.response.status).toBe("PROCESSED");
    expect(credit.response.transaction?.referenceTransactionId).toBeNull();
    const loss = await service.process(
      c.providerId,
      `${run}-free-loss-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-free-loss`, {
        kind: WagerTransactionKind.LOSS,
      }),
    );
    expect(loss.response.status).toBe("PROCESSED");
    expect(loss.response.wallet?.balance).toBe("97.00");

    // The BET still has no result: a WIN naming it is applied.
    const win = result(c.externalPlayerId, run, WagerTransactionKind.WIN);
    const settled = await service.process(
      c.providerId,
      win.idempotencyKey,
      win.wager,
    );
    expect(settled.response.status).toBe("PROCESSED");
    expect(settled.response.wallet?.balance).toBe("147.00");
    // Replays move nothing.
    const replay = await service.process(
      c.providerId,
      `${run}-free-win-key`,
      ctx.wagerInput(c.externalPlayerId, `${run}-free-win`, {
        kind: WagerTransactionKind.WIN,
        amount: "7.00",
      }),
    );
    expect(replay.idempotentReplay).toBe(true);
    const ledger = await ctx.orm.em.execute<{ count: string }[]>(
      `SELECT count(*)::text AS count
         FROM "${ctx.schema}".wallet_ledger_entries entry
         JOIN "${ctx.schema}".wager_transactions wager
           ON wager.id = entry.wager_transaction_id
        WHERE entry.wallet_id = ? AND wager.kind <> 'OPENING'`,
      [c.walletId],
    );
    // BET, free WIN, settling WIN. The LOSS writes nothing.
    expect(ledger[0]?.count).toBe("3");
    await ctx.expectWalletBalanceMatchesLedger(c.walletId);
  });

  test("PostgreSQL refuses a second active result even when the application is bypassed", async () => {
    const c = await ctx.seedWagerContext("100.00");
    const run = randomUUID();
    const service = new WagerTransactionsService(ctx.transactionManager);
    const pendingWin = result(
      c.externalPlayerId,
      run,
      WagerTransactionKind.WIN,
    );
    expect(
      (
        await service.process(
          c.providerId,
          pendingWin.idempotencyKey,
          pendingWin.wager,
        )
      ).response.status,
    ).toBe("PENDING_REFERENCE");

    const forged = ctx.orm.em.execute(
      `WITH op AS (
         INSERT INTO "${ctx.schema}".financial_operations
           (provider_id, idempotency_key, external_transaction_id,
            payload_hash, response_snapshot, response_http_status)
         VALUES (?, ?, ?, repeat('b', 64), '{}'::jsonb, 202)
         RETURNING id
       )
       INSERT INTO "${ctx.schema}".wager_transactions
         (provider_id, player_id, wallet_id, financial_operation_id,
          external_transaction_id, external_reference_transaction_id,
          kind, status, amount, currency)
       SELECT ?, ?, ?, op.id, ?, ?, 'LOSS', 'PENDING_REFERENCE', 10.00, 'BRL'
         FROM op`,
      [
        c.providerId,
        `${run}-forged-key`,
        `${run}-forged`,
        c.providerId,
        c.playerId,
        c.walletId,
        `${run}-forged`,
        `${run}-bet`,
      ],
    );
    await expect(forged).rejects.toThrow("BET already has an active result");

    // REFUND must name what it reverses, even when written by direct SQL.
    const noReference = ctx.orm.em.execute(
      `WITH op AS (
         INSERT INTO "${ctx.schema}".financial_operations
           (provider_id, idempotency_key, external_transaction_id,
            payload_hash, response_snapshot, response_http_status)
         VALUES (?, ?, ?, repeat('c', 64), '{}'::jsonb, 202)
         RETURNING id
       )
       INSERT INTO "${ctx.schema}".wager_transactions
         (provider_id, player_id, wallet_id, financial_operation_id,
          external_transaction_id, kind, status, amount, currency)
       SELECT ?, ?, ?, op.id, ?, 'REFUND', 'PENDING', 10.00, 'BRL' FROM op`,
      [
        c.providerId,
        `${run}-noref-key`,
        `${run}-noref`,
        c.providerId,
        c.playerId,
        c.walletId,
        `${run}-noref`,
      ],
    );
    await expect(noReference).rejects.toThrow(
      "ck_wager_transactions_reference_by_kind",
    );
  });
});
