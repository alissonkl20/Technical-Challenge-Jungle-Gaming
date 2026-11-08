import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { WagerTransactionKind } from "../../src/modules/finance/domain/index.js";
import { PendingReferenceRetryService } from "../../src/modules/transactions/pending-reference-retry.service.js";
import { PendingReferenceWorkerService } from "../../src/modules/transactions/pending-reference-worker.service.js";
import { WagerTransactionsService } from "../../src/modules/transactions/wager-transactions.service.js";
import { registerPostgresIntegrationSuite } from "../support/postgres-integration-context.js";

/**
 * Every arrival order of a dependency chain must converge on the same
 * financial result as the in-order delivery: same final balance, same Ledger
 * entries, every operation PROCESSED, balance equal to the Ledger.
 *
 * Chains here have one result per BET. Competing results of one BET (WIN vs
 * REFUND vs LOSS) follow "first valid result recorded wins" and are covered by
 * `bet-result-race.test.ts`.
 */
type Op = {
  readonly name: string;
  readonly kind: WagerTransactionKind;
  readonly amount: string;
  readonly reference?: string;
};

const BET: Op = {
  name: "bet",
  kind: WagerTransactionKind.BET,
  amount: "10.00",
};
const WIN: Op = {
  name: "win",
  kind: WagerTransactionKind.WIN,
  amount: "50.00",
  reference: "bet",
};
const LOSS: Op = {
  name: "loss",
  kind: WagerTransactionKind.LOSS,
  amount: "10.00",
  reference: "bet",
};
const REFUND: Op = {
  name: "refund",
  kind: WagerTransactionKind.REFUND,
  amount: "10.00",
  reference: "bet",
};
const ROLLBACK_BET: Op = {
  name: "rollback-bet",
  kind: WagerTransactionKind.ROLLBACK,
  amount: "10.00",
  reference: "bet",
};
const ROLLBACK_WIN: Op = {
  name: "rollback-win",
  kind: WagerTransactionKind.ROLLBACK,
  amount: "50.00",
  reference: "win",
};
const ROLLBACK_REFUND: Op = {
  name: "rollback-refund",
  kind: WagerTransactionKind.ROLLBACK,
  amount: "10.00",
  reference: "refund",
};

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest],
    ),
  );
}

interface Chain {
  readonly label: string;
  readonly ops: readonly Op[];
  /** Balance after every op is applied, starting from 100.00. */
  readonly finalBalance: string;
  /** Non-OPENING Ledger entries, as "DIRECTION amount", sorted. */
  readonly ledger: readonly string[];
}

const CHAINS: readonly Chain[] = [
  {
    label: "BET + WIN",
    ops: [BET, WIN],
    finalBalance: "140.00",
    ledger: ["CREDIT 50.00", "DEBIT 10.00"],
  },
  {
    label: "BET + LOSS",
    ops: [BET, LOSS],
    finalBalance: "90.00",
    ledger: ["DEBIT 10.00"],
  },
  {
    label: "BET + REFUND",
    ops: [BET, REFUND],
    finalBalance: "100.00",
    ledger: ["CREDIT 10.00", "DEBIT 10.00"],
  },
  {
    label: "BET + ROLLBACK(BET)",
    ops: [BET, ROLLBACK_BET],
    finalBalance: "100.00",
    ledger: ["CREDIT 10.00", "DEBIT 10.00"],
  },
  {
    label: "BET + WIN + ROLLBACK(WIN)",
    ops: [BET, WIN, ROLLBACK_WIN],
    finalBalance: "90.00",
    ledger: ["CREDIT 50.00", "DEBIT 10.00", "DEBIT 50.00"],
  },
  {
    label: "BET + REFUND + ROLLBACK(REFUND)",
    ops: [BET, REFUND, ROLLBACK_REFUND],
    finalBalance: "90.00",
    ledger: ["CREDIT 10.00", "DEBIT 10.00", "DEBIT 10.00"],
  },
];

registerPostgresIntegrationSuite(
  "out-of-order delivery converges on the in-order financial result",
  (ctx) => {
    const wagers = () => new WagerTransactionsService(ctx.transactionManager);

    async function drainPendingReferences(
      service: WagerTransactionsService,
      walletId: string,
    ): Promise<void> {
      const worker = new PendingReferenceWorkerService(
        ctx.transactionManager,
        new PendingReferenceRetryService(ctx.transactionManager, service),
        new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
      );
      // A chain can be pending on a pending transaction, so one pass may
      // only advance it by one link.
      for (let pass = 0; pass < 5; pass += 1) {
        const rows = await ctx.orm.em.execute<{ id: string }[]>(
          `UPDATE "${ctx.schema}".wager_transactions
              SET next_reference_attempt_at = now()
            WHERE wallet_id = ? AND status = 'PENDING_REFERENCE'
            RETURNING id`,
          [walletId],
        );
        if (rows.length === 0) return;
        await worker.processDue(100);
      }
    }

    async function deliver(
      order: readonly Op[],
      options: { readonly duplicateEach: boolean },
    ) {
      const c = await ctx.seedWagerContext("100.00");
      const service = wagers();
      const run = randomUUID();
      const submit = (op: Op) =>
        service.process(
          c.providerId,
          `${run}-${op.name}`,
          ctx.wagerInput(c.externalPlayerId, `${run}-${op.name}`, {
            kind: op.kind,
            amount: op.amount,
            roundId: "round-1",
            ...(op.reference === undefined
              ? {}
              : { externalReferenceTransactionId: `${run}-${op.reference}` }),
          }),
        );

      for (const op of order) {
        const first = await submit(op);
        expect(["PROCESSED", "PENDING_REFERENCE"]).toContain(
          first.response.status,
        );
        if (options.duplicateEach) {
          // A redelivery interleaved with out-of-order arrival: it must never
          // add a movement, whether the first copy is pending or processed.
          const again = await submit(op);
          expect(again.response.status).toBe(first.response.status);
          expect(again.response.transaction?.id).toBe(
            first.response.transaction?.id,
          );
        }
      }
      await drainPendingReferences(service, c.walletId);

      const statuses = await ctx.orm.em.execute<
        { external_transaction_id: string; status: string }[]
      >(
        `SELECT external_transaction_id, status
           FROM "${ctx.schema}".wager_transactions
          WHERE wallet_id = ? AND kind <> 'OPENING'`,
        [c.walletId],
      );
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(c.walletId),
      );
      const ledger = await ctx.orm.em.execute<{ line: string }[]>(
        `SELECT entry.entry_type || ' ' || entry.amount::text AS line
           FROM "${ctx.schema}".wallet_ledger_entries entry
           JOIN "${ctx.schema}".wager_transactions wager
             ON wager.id = entry.wager_transaction_id
          WHERE entry.wallet_id = ? AND wager.kind <> 'OPENING'`,
        [c.walletId],
      );
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);

      // Replaying every operation after convergence moves nothing.
      for (const op of order) {
        const replay = await submit(op);
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.response.status).toBe("PROCESSED");
      }
      const after = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(c.walletId),
      );
      expect(after?.balance).toBe(wallet?.balance);

      return {
        statuses: statuses.map((row) => row.status),
        balance: wallet?.balance,
        ledger: ledger.map((row) => row.line).sort(),
      };
    }

    for (const chain of CHAINS) {
      for (const order of permutations(chain.ops)) {
        const label = order.map((op) => op.name).join(" -> ");
        test(`${chain.label}: ${label}`, async () => {
          const outcome = await deliver(order, { duplicateEach: false });
          expect(outcome.statuses).toHaveLength(chain.ops.length);
          expect(outcome.statuses.every((s) => s === "PROCESSED")).toBe(true);
          expect(outcome.balance).toBe(chain.finalBalance);
          expect(outcome.ledger).toEqual([...chain.ledger].sort());
        }, 30_000);
      }
    }

    test("duplicates mixed with reverse-order delivery: ROLLBACK(WIN) x2, WIN x2, BET x2", async () => {
      const outcome = await deliver([ROLLBACK_WIN, WIN, BET], {
        duplicateEach: true,
      });
      expect(outcome.statuses).toEqual(["PROCESSED", "PROCESSED", "PROCESSED"]);
      expect(outcome.balance).toBe("90.00");
      expect(outcome.ledger).toEqual(
        ["CREDIT 50.00", "DEBIT 10.00", "DEBIT 50.00"].sort(),
      );
    }, 30_000);

    test("REFUND and ROLLBACK of one BET, both delivered before it, credit the BET back exactly once", async () => {
      const c = await ctx.seedWagerContext("100.00");
      const service = wagers();
      const run = randomUUID();
      const reversals = [REFUND, ROLLBACK_BET].map((op) =>
        service.process(
          c.providerId,
          `${run}-${op.name}`,
          ctx.wagerInput(c.externalPlayerId, `${run}-${op.name}`, {
            kind: op.kind,
            amount: op.amount,
            roundId: "round-1",
            externalReferenceTransactionId: `${run}-bet`,
          }),
        ),
      );
      expect(
        (await Promise.all(reversals)).map((r) => r.response.status),
      ).toEqual(["PENDING_REFERENCE", "PENDING_REFERENCE"]);
      await service.process(
        c.providerId,
        `${run}-bet`,
        ctx.wagerInput(c.externalPlayerId, `${run}-bet`, {
          amount: "10.00",
          roundId: "round-1",
        }),
      );
      await drainPendingReferences(service, c.walletId);

      const rows = await ctx.orm.em.execute<
        { status: string; failure_code: string | null }[]
      >(
        `SELECT status, failure_code FROM "${ctx.schema}".wager_transactions
          WHERE wallet_id = ? AND kind IN ('REFUND', 'ROLLBACK')
          ORDER BY status`,
        [c.walletId],
      );
      expect(rows).toEqual([
        { status: "PROCESSED", failure_code: null },
        { status: "REJECTED", failure_code: "REFERENCE_ALREADY_REVERSED" },
      ]);
      const wallet = await ctx.transactionManager.transaction((session) =>
        session.wallets.findById(c.walletId),
      );
      expect(wallet?.balance).toBe("100.00");
      await ctx.expectWalletBalanceMatchesLedger(c.walletId);
    }, 30_000);
  },
);
