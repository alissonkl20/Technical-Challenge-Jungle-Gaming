import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "./postgres-integration-context.js";
import {
  ConfigService,
  MikroOrmTransactionManager,
  PendingReferenceRetryService,
  PendingReferenceWorkerService,
  randomUUID,
  spawn,
  WagerTransactionKind,
  WagerTransactionsService,
} from "./postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL pending references and retry processing",
  (integrationContext) => {
    describe("pending references and retry processing", () => {
      test("persists missing references without changing the wallet", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const pending = await wagers.process(
          context.providerId,
          "pending-ref-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "pending-ref-wager",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "not-arrived-yet",
            },
          ),
        );

        expect(pending.httpStatus).toBe(202);
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        expect(pending.response.wallet?.balance).toBe("100.00");
        const pendingRows = await integrationContext.orm.em.execute<
          {
            status: string;
            next_reference_attempt_at: Date | null;
            reference_expires_at: Date | null;
          }[]
        >(
          `SELECT status, next_reference_attempt_at, reference_expires_at
       FROM "${integrationContext.schema}".wager_transactions
       WHERE wallet_id = ? AND kind <> 'OPENING'`,
          [context.walletId],
        );
        expect(pendingRows[0]?.status).toBe("PENDING_REFERENCE");
        expect(pendingRows[0]?.next_reference_attempt_at).not.toBeNull();
        expect(pendingRows[0]?.reference_expires_at).not.toBeNull();
      });

      test("resolves pending references with the shared financial use case", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const pending = await wagers.process(
          context.providerId,
          "late-refund-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "late-refund",
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: "late-bet",
            },
          ),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");

        await wagers.process(
          context.providerId,
          "late-bet-key",
          integrationContext.wagerInput(context.externalPlayerId, "late-bet", {
            amount: "10.00",
          }),
        );
        const pendingId = pending.response.transaction?.id;
        if (pendingId === undefined) {
          throw new Error("Pending refund did not return its transaction");
        }
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
       SET next_reference_attempt_at = now()
       WHERE id = ?`,
          [pendingId],
        );

        const worker = new PendingReferenceWorkerService(
          integrationContext.transactionManager,
          new PendingReferenceRetryService(
            integrationContext.transactionManager,
            wagers,
          ),
          new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
        );
        const result = await worker.processDue(10);
        expect(result).toEqual({
          examined: 1,
          completed: 1,
          retried: 0,
          failed: 0,
          failures: [],
        });

        const resolved =
          await integrationContext.transactionManager.transaction((session) =>
            session.wagerTransactions.findById(pendingId),
          );
        expect(resolved?.status).toBe("PROCESSED");
        expect(resolved?.reference_transaction_id).not.toBeNull();
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(wallet?.balance).toBe("50.00");
        expect(
          await integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.findByTransactionId(pendingId),
          ),
        ).not.toBeNull();
        expect(
          (
            await wagers.process(
              context.providerId,
              "late-refund-key",
              integrationContext.wagerInput(
                context.externalPlayerId,
                "late-refund",
                {
                  kind: WagerTransactionKind.REFUND,
                  externalReferenceTransactionId: "late-bet",
                },
              ),
            )
          ).response.status,
        ).toBe("PROCESSED");
      });

      test("resolves one pending reference safely when two workers process it concurrently", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const firstWorkerTransactions = new MikroOrmTransactionManager(
          integrationContext.orm.em,
        );
        const secondWorkerTransactions = new MikroOrmTransactionManager(
          integrationContext.orm.em,
        );
        const firstWagers = new WagerTransactionsService(
          firstWorkerTransactions,
        );
        const secondWagers = new WagerTransactionsService(
          secondWorkerTransactions,
        );
        const pending = await firstWagers.process(
          context.providerId,
          `concurrent-reference-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `concurrent-refund-${randomUUID()}`,
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: `concurrent-late-bet-${randomUUID()}`,
            },
          ),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        const pendingId = pending.response.transaction?.id;
        const pendingExternalId = pending.response.externalTransactionId;
        const referencedExternalId =
          pending.response.transaction?.externalReferenceTransactionId;
        if (
          pendingId === undefined ||
          pendingExternalId === undefined ||
          referencedExternalId === undefined ||
          referencedExternalId === null
        ) {
          throw new Error(
            "Pending refund did not return its persisted identity",
          );
        }

        await firstWagers.process(
          context.providerId,
          `concurrent-reference-target-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            referencedExternalId,
            {
              amount: "10.00",
            },
          ),
        );
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now()
         WHERE id = ?`,
          [pendingId],
        );

        const firstWorker = new PendingReferenceWorkerService(
          firstWorkerTransactions,
          new PendingReferenceRetryService(
            firstWorkerTransactions,
            firstWagers,
          ),
          new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
        );
        const secondWorker = new PendingReferenceWorkerService(
          secondWorkerTransactions,
          new PendingReferenceRetryService(
            secondWorkerTransactions,
            secondWagers,
          ),
          new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
        );
        const results = await Promise.all([
          firstWorker.processDue(10),
          secondWorker.processDue(10),
        ]);

        expect(
          results.reduce((total, result) => total + result.examined, 0),
        ).toBeGreaterThanOrEqual(1);
        expect(results.flatMap((result) => result.failures)).toEqual([]);

        const state = await integrationContext.orm.em.execute<
          {
            pending_status: string;
            reference_id: string | null;
            balance: string;
            refund_operation_count: string;
            refund_count: string;
            refund_ledger_count: string;
            refund_outbox_count: string;
          }[]
        >(
          `SELECT
           pending.status AS pending_status,
           pending.reference_transaction_id AS reference_id,
           wallet.balance::text AS balance,
           (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS refund_operation_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE provider_id = ? AND external_transaction_id = ?)
              AS refund_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wager_transaction_id = pending.id) AS refund_ledger_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".outbox
            WHERE COALESCE(payload->'data'->>'wagerTransactionId', payload->'data'->>'transactionId') = pending.id::text)
              AS refund_outbox_count
         FROM "${integrationContext.schema}".wager_transactions pending
         JOIN "${integrationContext.schema}".wallets wallet ON wallet.id = pending.wallet_id
         WHERE pending.id = ?`,
          [
            context.providerId,
            pendingExternalId,
            context.providerId,
            pendingExternalId,
            pendingId,
          ],
        );
        expect(state[0]).toMatchObject({
          pending_status: "PROCESSED",
          balance: "50.00",
          refund_operation_count: "1",
          refund_count: "1",
          refund_ledger_count: "1",
          refund_outbox_count: "3",
        });
        expect(state[0]?.reference_id).not.toBeNull();
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("recovers a pending reference after its worker process crashes during Ledger insertion", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const referenceExternalId = `restart-reference-bet-${randomUUID()}`;
        const pending = await wagers.process(
          context.providerId,
          `restart-reference-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `restart-reference-refund-${randomUUID()}`,
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: referenceExternalId,
            },
          ),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        const pendingId = pending.response.transaction?.id;
        if (pendingId === undefined) {
          throw new Error("Pending refund did not return its transaction ID");
        }

        await wagers.process(
          context.providerId,
          `restart-reference-target-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            referenceExternalId,
            {
              amount: "10.00",
            },
          ),
        );
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now() + interval '1 hour'
         WHERE status = 'PENDING_REFERENCE' AND id <> ?`,
          [pendingId],
        );
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now()
         WHERE id = ?`,
          [pendingId],
        );

        const triggerName = `pause_reference_ledger_${randomUUID().replaceAll("-", "")}`;
        const functionName = `${triggerName}_function`;
        const sequenceName = `${triggerName}_sequence`;
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
         BEFORE INSERT ON "${integrationContext.schema}".wallet_ledger_entries
         FOR EACH ROW EXECUTE FUNCTION "${integrationContext.schema}"."${functionName}"()`,
        );

        function startWorkerProcess() {
          const child = spawn(
            process.execPath,
            [
              new URL("./support/process-pending-reference.ts", import.meta.url)
                .pathname,
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                POSTGRES_SCHEMA: integrationContext.schema,
                PENDING_REFERENCE_INITIAL_DELAY_MS: "1",
              },
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
          return { child, stdout: () => stdout, stderr: () => stderr };
        }

        const firstWorker = startWorkerProcess();
        let restartedWorker: ReturnType<typeof startWorkerProcess> | undefined;
        const stopWorkerProcess = async (
          worker: ReturnType<typeof startWorkerProcess>,
        ) => {
          if (
            worker.child.exitCode !== null ||
            worker.child.signalCode !== null
          ) {
            return;
          }
          const closed = new Promise<void>((resolve) =>
            worker.child.once("close", () => resolve()),
          );
          worker.child.kill("SIGKILL");
          await closed;
        };
        try {
          let workerPausedInPostgres = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (
              firstWorker.child.exitCode !== null ||
              firstWorker.child.signalCode !== null
            ) {
              throw new Error(
                `Pending reference worker exited before fault injection: ${firstWorker.stderr()}${firstWorker.stdout()}`,
              );
            }
            const activity = await integrationContext.orm.em.execute<
              { count: string }[]
            >(
              `SELECT count(*)::text AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND state = 'active'
               AND wait_event = 'PgSleep'`,
            );
            if (activity[0]?.count === "1") {
              workerPausedInPostgres = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          expect(workerPausedInPostgres).toBe(true);

          const firstWorkerClosed = new Promise<{
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }>((resolve) =>
            firstWorker.child.once("close", (code, signal) =>
              resolve({ code, signal }),
            ),
          );
          firstWorker.child.kill("SIGKILL");
          expect(await firstWorkerClosed).toMatchObject({
            code: null,
            signal: "SIGKILL",
          });

          let sleepingBackendCount = "1";
          for (
            let attempt = 0;
            attempt < 200 && sleepingBackendCount !== "0";
            attempt += 1
          ) {
            const activity = await integrationContext.orm.em.execute<
              { count: string }[]
            >(
              `SELECT count(*)::text AS count
             FROM pg_stat_activity
             WHERE datname = current_database()
               AND state = 'active'
               AND wait_event = 'PgSleep'`,
            );
            sleepingBackendCount = activity[0]?.count ?? "0";
            if (sleepingBackendCount !== "0") {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          }
          expect(sleepingBackendCount).toBe("0");

          const afterCrash = await integrationContext.orm.em.execute<
            {
              status: string;
              balance: string;
              refund_ledger_count: string;
            }[]
          >(
            `SELECT pending.status,
                  wallet.balance::text AS balance,
                  (SELECT count(*)::text
                   FROM "${integrationContext.schema}".wallet_ledger_entries
                   WHERE wager_transaction_id = pending.id)
                    AS refund_ledger_count
           FROM "${integrationContext.schema}".wager_transactions pending
           JOIN "${integrationContext.schema}".wallets wallet ON wallet.id = pending.wallet_id
           WHERE pending.id = ?`,
            [pendingId],
          );
          expect(afterCrash[0]).toEqual({
            status: "PENDING_REFERENCE",
            balance: "40.00",
            refund_ledger_count: "0",
          });

          restartedWorker = startWorkerProcess();
          const restartResult = await new Promise<{
            readonly code: number | null;
            readonly stdout: string;
            readonly stderr: string;
          }>((resolve, reject) => {
            restartedWorker?.child.once("error", reject);
            restartedWorker?.child.once("close", (code) =>
              resolve({
                code,
                stdout: restartedWorker?.stdout() ?? "",
                stderr: restartedWorker?.stderr() ?? "",
              }),
            );
          });
          expect(restartResult.code).toBe(0);
          expect(JSON.parse(restartResult.stdout.trim())).toMatchObject({
            examined: 1,
            completed: 1,
            retried: 0,
            failed: 0,
            failures: [],
          });

          const afterRestart = await integrationContext.orm.em.execute<
            {
              status: string;
              balance: string;
              refund_ledger_count: string;
              operation_count: string;
              refund_count: string;
            }[]
          >(
            `SELECT pending.status,
                  wallet.balance::text AS balance,
                  (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
                   WHERE wager_transaction_id = pending.id)
                    AS refund_ledger_count,
                  (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
                   WHERE provider_id = pending.provider_id
                     AND external_transaction_id = pending.external_transaction_id)
                    AS operation_count,
                  (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
                   WHERE provider_id = pending.provider_id
                     AND external_transaction_id = pending.external_transaction_id)
                    AS refund_count
           FROM "${integrationContext.schema}".wager_transactions pending
           JOIN "${integrationContext.schema}".wallets wallet ON wallet.id = pending.wallet_id
           WHERE pending.id = ?`,
            [pendingId],
          );
          expect(afterRestart[0]).toEqual({
            status: "PROCESSED",
            balance: "50.00",
            refund_ledger_count: "1",
            operation_count: "1",
            refund_count: "1",
          });
          await integrationContext.expectWalletBalanceMatchesLedger(
            context.walletId,
          );
        } finally {
          await stopWorkerProcess(firstWorker);
          if (restartedWorker !== undefined) {
            await stopWorkerProcess(restartedWorker);
          }
          await integrationContext.orm.em.execute(
            `DROP TRIGGER "${triggerName}" ON "${integrationContext.schema}".wallet_ledger_entries`,
          );
          await integrationContext.orm.em.execute(
            `DROP FUNCTION "${integrationContext.schema}"."${functionName}"()`,
          );
          await integrationContext.orm.em.execute(
            `DROP SEQUENCE "${integrationContext.schema}"."${sequenceName}"`,
          );
        }
      }, 60_000);

      test("resolves a ROLLBACK that arrived before its referenced WIN", async () => {
        const context = await integrationContext.seedWagerContext("1.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const rollback = await wagers.process(
          context.providerId,
          `early-rollback-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `early-rollback-${randomUUID()}`,
            {
              kind: WagerTransactionKind.ROLLBACK,
              amount: "20.00",
              externalReferenceTransactionId: "late-win",
            },
          ),
        );
        expect(rollback.response.status).toBe("PENDING_REFERENCE");

        await wagers.process(
          context.providerId,
          `late-win-bet-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            "late-win-bet",
            { amount: "1.00" },
          ),
        );
        await wagers.process(
          context.providerId,
          `late-win-key-${randomUUID()}`,
          integrationContext.wagerInput(context.externalPlayerId, "late-win", {
            kind: WagerTransactionKind.WIN,
            amount: "20.00",
            externalReferenceTransactionId: "late-win-bet",
          }),
        );
        const pendingId = rollback.response.transaction?.id;
        if (pendingId === undefined) {
          throw new Error("Pending rollback did not return its transaction ID");
        }
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now() + interval '1 hour'
         WHERE status = 'PENDING_REFERENCE' AND id <> ?`,
          [pendingId],
        );
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET next_reference_attempt_at = now()
         WHERE id = ?`,
          [pendingId],
        );

        const worker = new PendingReferenceWorkerService(
          integrationContext.transactionManager,
          new PendingReferenceRetryService(
            integrationContext.transactionManager,
            wagers,
          ),
          new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
        );
        const result = await worker.processDue(10);
        expect(result).toEqual({
          examined: 1,
          completed: 1,
          retried: 0,
          failed: 0,
          failures: [],
        });

        const resolved =
          await integrationContext.transactionManager.transaction((session) =>
            session.wagerTransactions.findById(pendingId),
          );
        const wallet = await integrationContext.transactionManager.transaction(
          (session) => session.wallets.findById(context.walletId),
        );
        expect(resolved?.status).toBe("PROCESSED");
        expect(wallet?.balance).toBe("0.00");
        expect(
          await integrationContext.transactionManager.transaction((session) =>
            session.walletLedger.findByTransactionId(pendingId),
          ),
        ).not.toBeNull();
        await integrationContext.expectWalletBalanceMatchesLedger(
          context.walletId,
        );
      });

      test("expires unresolved references without moving the wallet", async () => {
        const context = await integrationContext.seedWagerContext("50.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const pending = await wagers.process(
          context.providerId,
          `expired-ref-key-${randomUUID()}`,
          integrationContext.wagerInput(
            context.externalPlayerId,
            `expired-ref-${randomUUID()}`,
            {
              kind: WagerTransactionKind.REFUND,
              externalReferenceTransactionId: `never-arrived-${randomUUID()}`,
            },
          ),
        );
        expect(pending.response.status).toBe("PENDING_REFERENCE");
        const pendingId = pending.response.transaction?.id;
        if (pendingId === undefined) {
          throw new Error(
            "Pending operation did not return its transaction ID",
          );
        }
        await integrationContext.orm.em.execute(
          `UPDATE "${integrationContext.schema}".wager_transactions
         SET reference_expires_at = now() - interval '1 minute',
             next_reference_attempt_at = now()
         WHERE id = ?`,
          [pendingId],
        );

        const worker = new PendingReferenceWorkerService(
          integrationContext.transactionManager,
          new PendingReferenceRetryService(
            integrationContext.transactionManager,
            wagers,
          ),
          new ConfigService({ PENDING_REFERENCE_INITIAL_DELAY_MS: 1 }),
        );
        const result = await worker.processDue(10);
        expect(result).toMatchObject({
          examined: 1,
          completed: 1,
          retried: 0,
          failed: 0,
          failures: [],
        });
        const persisted =
          await integrationContext.transactionManager.transaction(
            async (session) => ({
              wager: await session.wagerTransactions.findById(pendingId),
              wallet: await session.wallets.findById(context.walletId),
              ledger: await session.walletLedger.findByTransactionId(pendingId),
            }),
          );
        expect(persisted.wager?.status).toBe("REJECTED");
        expect(persisted.wager?.failure_code).toBe("REFERENCE_NOT_FOUND");
        expect(persisted.wallet?.balance).toBe("50.00");
        expect(persisted.ledger).toBeNull();
        const rejectionEvents = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count FROM "${integrationContext.schema}".outbox
       WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`,
          [pendingId],
        );
        expect(rejectionEvents[0]?.count).toBe("1");
      });

      test("records the required financial Outbox event types in the operation commit", async () => {
        const context = await integrationContext.seedWagerContext("20.00");
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const processed = await wagers.process(
          context.providerId,
          "event-bet-key",
          integrationContext.wagerInput(context.externalPlayerId, "event-bet"),
        );
        const rejected = await wagers.process(
          context.providerId,
          "event-rejected-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "event-rejected",
            {
              amount: "30.00",
            },
          ),
        );
        const pending = await wagers.process(
          context.providerId,
          "event-pending-key",
          integrationContext.wagerInput(
            context.externalPlayerId,
            "event-pending",
            {
              kind: WagerTransactionKind.WIN,
              externalReferenceTransactionId: "not-yet-arrived",
            },
          ),
        );

        const transactionEvents = async (aggregateId: string) =>
          (
            await integrationContext.orm.em.execute<{ event_type: string }[]>(
              `SELECT event_type FROM "${integrationContext.schema}".outbox
           WHERE aggregate_id = ? ORDER BY event_type`,
              [aggregateId],
            )
          ).map((row) => row.event_type);
        expect(
          await transactionEvents(processed.response.transaction?.id ?? ""),
        ).toEqual(["WagerTransactionProcessed"]);
        expect(
          await transactionEvents(rejected.response.transaction?.id ?? ""),
        ).toEqual(["WagerTransactionRejected"]);
        expect(
          await transactionEvents(pending.response.transaction?.id ?? ""),
        ).toEqual(["WagerTransactionPendingReference"]);
        expect(await transactionEvents(context.walletId)).toEqual([
          "WalletBalanceChanged",
        ]);
      });

      test("rejects inactive providers as an idempotent business result", async () => {
        const context = await integrationContext.seedWagerContext();
        await integrationContext.transactionManager.transaction((session) =>
          session.providers.updateStatus(context.providerId, "INACTIVE"),
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          "inactive-provider-wager",
        );
        const rejected = await wagers.process(
          context.providerId,
          "inactive-provider-key",
          input,
        );

        expect(rejected.httpStatus).toBe(422);
        expect(rejected.idempotentReplay).toBe(false);
        expect(rejected.response.failureCode).toBe("PROVIDER_INACTIVE");
        expect(rejected.response.transaction).toBeNull();
        const inactiveReplay = await wagers.process(
          context.providerId,
          "inactive-provider-key",
          input,
        );
        expect(inactiveReplay).toEqual({
          ...rejected,
          idempotentReplay: true,
        });
      });

      test("rejects a pending reference when its provider becomes inactive", async () => {
        const context = await integrationContext.seedWagerContext();
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const idempotencyKey = `pending-inactive-provider-key-${randomUUID()}`;
        const input = integrationContext.wagerInput(
          context.externalPlayerId,
          `pending-inactive-provider-${randomUUID()}`,
          {
            kind: WagerTransactionKind.REFUND,
            externalReferenceTransactionId: `missing-reference-${randomUUID()}`,
          },
        );
        const pending = await wagers.process(
          context.providerId,
          idempotencyKey,
          input,
        );
        const pendingId = pending.response.transaction?.id;
        if (pendingId === undefined) {
          throw new Error("Pending reference did not return its transaction");
        }

        await integrationContext.transactionManager.transaction((session) =>
          session.providers.updateStatus(context.providerId, "INACTIVE"),
        );
        const rejected = await wagers.process(
          context.providerId,
          idempotencyKey,
          input,
        );

        expect(pending.response.status).toBe("PENDING_REFERENCE");
        expect(rejected.httpStatus).toBe(422);
        expect(rejected.response).toMatchObject({
          status: "REJECTED",
          failureCode: "PROVIDER_INACTIVE",
          transaction: null,
          wallet: null,
        });

        const persisted =
          await integrationContext.transactionManager.transaction(
            async (session) => ({
              wager: await session.wagerTransactions.findById(pendingId),
              operation: await session.financialOperations.findByIdempotencyKey(
                context.providerId,
                idempotencyKey,
              ),
              wallet: await session.wallets.findById(context.walletId),
            }),
          );
        expect(persisted.wager).toMatchObject({
          status: "REJECTED",
          failure_code: "PROVIDER_INACTIVE",
          reference_attempts: 1,
          next_reference_attempt_at: null,
        });
        expect(persisted.operation?.response_snapshot).toEqual(
          rejected.response,
        );
        expect(persisted.operation?.completed_at).not.toBeNull();
        expect(persisted.wallet?.balance).toBe("100.00");
        const rejectionEvents = await integrationContext.orm.em.execute<
          { count: string }[]
        >(
          `SELECT count(*)::text AS count FROM "${integrationContext.schema}".outbox
       WHERE aggregate_id = ? AND event_type = 'WagerTransactionRejected'`,
          [pendingId],
        );
        expect(rejectionEvents[0]?.count).toBe("1");
      });
    });
  },
);
