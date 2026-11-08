import { describe, expect, test } from "bun:test";
import { registerPostgresIntegrationSuite } from "../../support/postgres-integration-context.js";
import {
  PlayersService,
  ProvidersService,
  randomUUID,
  WagerTransactionKind,
  WagerTransactionsService,
  WalletsService,
} from "../../support/postgres-test-dependencies.js";

registerPostgresIntegrationSuite(
  "PostgreSQL generated financial properties",
  (integrationContext) => {
    describe("generated financial properties", () => {
      test("preserves wallet and Ledger invariants across generated sequences with seed 0x5eed1234", async () => {
        let randomState = 0x5eed1234n;
        const nextRandom = (maximum: number): number => {
          randomState =
            (1_664_525n * randomState + 1_013_904_223n) & 0xffff_ffffn;
          return Number(randomState % BigInt(maximum));
        };
        const decimalFromCents = (cents: bigint): string =>
          `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const generatedWallets = await Promise.all(
          Array.from({ length: 4 }, () =>
            integrationContext.seedWagerContext("100.00"),
          ),
        );
        const expectations = new Map<
          string,
          {
            readonly providerId: string;
            balanceCents: bigint;
            successful: number;
            rejected: number;
            wageredCents: bigint;
          }
        >();

        for (const context of generatedWallets) {
          const expected = {
            providerId: context.providerId,
            balanceCents: 10_000n,
            successful: 0,
            rejected: 0,
            wageredCents: 0n,
          };
          expectations.set(context.walletId, expected);

          for (let index = 0; index < 20; index += 1) {
            const amountCents = BigInt(1 + nextRandom(5_000));
            const amount = decimalFromCents(amountCents);
            const shouldProcess = amountCents <= expected.balanceCents;
            const result = await wagers.process(
              context.providerId,
              `generated-key-${randomUUID()}`,
              integrationContext.wagerInput(
                context.externalPlayerId,
                `generated-external-${randomUUID()}`,
                { amount },
              ),
            );

            if (shouldProcess) {
              expected.balanceCents -= amountCents;
              expected.successful += 1;
              expected.wageredCents += amountCents;
              expect(result.httpStatus).toBe(200);
              expect(result.response.status).toBe("PROCESSED");
              expect(result.response.wallet?.balance).toBe(
                decimalFromCents(expected.balanceCents),
              );
            } else {
              expected.rejected += 1;
              expect(result.httpStatus).toBe(422);
              expect(result.response.status).toBe("REJECTED");
              expect(result.response.failureCode).toBe("INSUFFICIENT_FUNDS");
              expect(result.response.wallet?.balance).toBe(
                decimalFromCents(expected.balanceCents),
              );
            }
          }
        }

        for (const [walletId, expected] of expectations) {
          const rows = await integrationContext.orm.em.execute<
            {
              balance: string;
              version: number;
              processed_count: string;
              rejected_count: string;
              ledger_count: string;
              ledger_balance: string;
              wagered_amount: string;
              operation_count: string;
            }[]
          >(
            `SELECT
           wallet.balance::text AS balance,
           wallet.version,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE wallet_id = wallet.id AND kind <> 'OPENING'
              AND status = 'PROCESSED') AS processed_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions
            WHERE wallet_id = wallet.id AND kind <> 'OPENING'
              AND status = 'REJECTED') AS rejected_count,
           (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = wallet.id) AS ledger_count,
           (SELECT COALESCE(SUM(
              CASE entry_type WHEN 'CREDIT' THEN amount ELSE -amount END
            ), 0)::numeric(20, 2)::text
            FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = wallet.id) AS ledger_balance,
           (SELECT COALESCE(SUM(amount), 0)::numeric(20, 2)::text
            FROM "${integrationContext.schema}".wallet_ledger_entries
            WHERE wallet_id = wallet.id AND entry_type = 'DEBIT') AS wagered_amount,
           (SELECT count(*)::text FROM "${integrationContext.schema}".financial_operations
            WHERE provider_id = ? AND external_transaction_id IN (
              SELECT external_transaction_id
              FROM "${integrationContext.schema}".wager_transactions
              WHERE wallet_id = wallet.id AND kind <> 'OPENING'
            )) AS operation_count
         FROM "${integrationContext.schema}".wallets wallet
         WHERE wallet.id = ?`,
            [expected.providerId, walletId],
          );
          expect(rows).toHaveLength(1);
          expect(rows[0]).toEqual({
            balance: decimalFromCents(expected.balanceCents),
            version: 2 + expected.successful,
            processed_count: String(expected.successful),
            rejected_count: String(expected.rejected),
            ledger_count: String(1 + expected.successful),
            ledger_balance: decimalFromCents(expected.balanceCents),
            wagered_amount: decimalFromCents(expected.wageredCents),
            operation_count: "20",
          });
        }
      });

      test("preserves financial properties across generated multi-provider sequences with seed 0x15eed2026", async () => {
        const seed = 0x15eed2026n;
        let randomState = seed;
        const nextRandom = (maximum: number): number => {
          randomState =
            (1_664_525n * randomState + 1_013_904_223n) & 0xffff_ffffn;
          return Number(randomState % BigInt(maximum));
        };
        const decimalFromCents = (cents: bigint): string =>
          `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
        const providers = new ProvidersService(
          integrationContext.transactionManager,
        );
        const players = new PlayersService(
          integrationContext.transactionManager,
        );
        const wallets = new WalletsService(
          integrationContext.transactionManager,
        );
        const wagers = new WagerTransactionsService(
          integrationContext.transactionManager,
        );
        const contexts: {
          readonly providerId: string;
          readonly playerId: string;
          readonly externalPlayerId: string;
          readonly walletId: string;
          readonly currency: "BRL" | "USD";
          balanceCents: bigint;
          readonly processedBets: {
            readonly externalTransactionId: string;
            readonly amountCents: bigint;
          }[];
          /** BETs that already received their one result (WIN or LOSS). */
          readonly settledBets: Set<string>;
          readonly actions: {
            readonly kind: WagerTransactionKind;
            readonly amountCents: bigint;
            readonly idempotencyKey: string;
            readonly externalTransactionId: string;
          }[];
        }[] = [];

        for (let providerIndex = 0; providerIndex < 2; providerIndex += 1) {
          const provider = await providers.register({
            code: `property-${seed}-${providerIndex}-${randomUUID()}`,
            name: `Generated provider ${providerIndex}`,
          });
          for (let playerIndex = 0; playerIndex < 2; playerIndex += 1) {
            const externalPlayerId = `property-player-${providerIndex}-${playerIndex}-${randomUUID()}`;
            const player = await players.register(provider.id, {
              externalPlayerId,
            });
            for (const currency of ["BRL", "USD"] as const) {
              const wallet = await wallets.open(
                provider.id,
                player.id,
                currency,
                { amount: "100.00", currency },
              );
              contexts.push({
                providerId: provider.id,
                playerId: player.id,
                externalPlayerId,
                walletId: wallet.id,
                currency,
                balanceCents: 10_000n,
                processedBets: [],
                settledBets: new Set<string>(),
                actions: Array.from({ length: 12 }, (_, actionIndex) => {
                  const kinds = [
                    WagerTransactionKind.BET,
                    WagerTransactionKind.WIN,
                    WagerTransactionKind.LOSS,
                  ] as const;
                  const kind = kinds[nextRandom(kinds.length)];
                  if (kind === undefined) {
                    throw new Error(
                      `Seed ${seed}: generated an invalid transaction kind`,
                    );
                  }
                  return {
                    kind,
                    amountCents: BigInt(1 + nextRandom(3_000)),
                    idempotencyKey: `property-key-${providerIndex}-${playerIndex}-${currency}-${actionIndex}-${randomUUID()}`,
                    externalTransactionId: `property-tx-${providerIndex}-${playerIndex}-${currency}-${actionIndex}-${randomUUID()}`,
                  };
                }),
              });
            }
          }
        }

        for (let round = 0; round < 12; round += 1) {
          const order = [...contexts];
          for (let index = order.length - 1; index > 0; index -= 1) {
            const swapIndex = nextRandom(index + 1);
            const current = order[index];
            const target = order[swapIndex];
            if (current === undefined || target === undefined) {
              throw new Error(
                `Seed ${seed}: failed to shuffle operation order`,
              );
            }
            order[index] = target;
            order[swapIndex] = current;
          }
          await Promise.all(
            order.map(async (context) => {
              const action = context.actions[round];
              if (action === undefined) {
                throw new Error(
                  `Seed ${seed}: missing generated action ${round}`,
                );
              }
              const amount = decimalFromCents(action.amountCents);
              // A WIN or LOSS is the one result of a processed BET. The first
              // BET is kept unsettled for the reversal checks below.
              let settles: string | undefined;
              if (action.kind !== WagerTransactionKind.BET) {
                settles = context.processedBets
                  .slice(1)
                  .find(
                    (bet) =>
                      !context.settledBets.has(bet.externalTransactionId),
                  )?.externalTransactionId;
                if (settles === undefined) {
                  return;
                }
                context.settledBets.add(settles);
              }
              const input = integrationContext.wagerInput(
                context.externalPlayerId,
                action.externalTransactionId,
                {
                  kind: action.kind,
                  amount,
                  currency: context.currency,
                  ...(settles === undefined
                    ? {}
                    : { externalReferenceTransactionId: settles }),
                },
              );
              const result = await wagers.process(
                context.providerId,
                action.idempotencyKey,
                input,
              );
              if (action.kind === WagerTransactionKind.BET) {
                if (action.amountCents <= context.balanceCents) {
                  context.balanceCents -= action.amountCents;
                  expect(result.response.status).toBe("PROCESSED");
                  const transactionId = result.response.transaction?.id;
                  if (transactionId === undefined) {
                    throw new Error(
                      `Seed ${seed}: processed BET lacks transaction ID`,
                    );
                  }
                  context.processedBets.push({
                    externalTransactionId: action.externalTransactionId,
                    amountCents: action.amountCents,
                  });
                } else {
                  expect(result.response.status).toBe("REJECTED");
                  expect(result.response.failureCode).toBe(
                    "INSUFFICIENT_FUNDS",
                  );
                }
              } else if (action.kind === WagerTransactionKind.WIN) {
                context.balanceCents += action.amountCents;
                expect(result.response.status).toBe("PROCESSED");
              } else {
                expect(result.response.status).toBe("PROCESSED");
              }
              expect(result.response.wallet?.balance).toBe(
                decimalFromCents(context.balanceCents),
              );

              if (nextRandom(4) === 0) {
                const [firstReplay, secondReplay] = await Promise.all([
                  wagers.process(
                    context.providerId,
                    action.idempotencyKey,
                    input,
                  ),
                  wagers.process(
                    context.providerId,
                    action.idempotencyKey,
                    input,
                  ),
                ]);
                expect(firstReplay).toEqual({
                  ...result,
                  idempotentReplay: true,
                });
                expect(secondReplay).toEqual({
                  ...result,
                  idempotentReplay: true,
                });
              }
            }),
          );
        }

        for (const [contextIndex, context] of contexts.entries()) {
          const target = context.processedBets[0];
          if (target === undefined) {
            continue;
          }
          const reversalKinds = [
            WagerTransactionKind.REFUND,
            WagerTransactionKind.ROLLBACK,
          ] as const;
          const firstKind = reversalKinds[nextRandom(reversalKinds.length)];
          const secondKind =
            firstKind === WagerTransactionKind.REFUND
              ? WagerTransactionKind.ROLLBACK
              : WagerTransactionKind.REFUND;
          if (firstKind === undefined) {
            throw new Error(`Seed ${seed}: generated an invalid reversal kind`);
          }
          const firstReversalId = `property-reversal-${contextIndex}-${randomUUID()}`;
          const firstReversal = await wagers.process(
            context.providerId,
            `property-reversal-key-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              firstReversalId,
              {
                kind: firstKind,
                amount: decimalFromCents(target.amountCents),
                currency: context.currency,
                externalReferenceTransactionId: target.externalTransactionId,
              },
            ),
          );
          expect(firstReversal.response.status).toBe("PROCESSED");
          context.balanceCents += target.amountCents;
          expect(firstReversal.response.wallet?.balance).toBe(
            decimalFromCents(context.balanceCents),
          );
          const duplicateReversal = await wagers.process(
            context.providerId,
            `property-duplicate-reversal-key-${randomUUID()}`,
            integrationContext.wagerInput(
              context.externalPlayerId,
              `property-duplicate-reversal-${contextIndex}-${randomUUID()}`,
              {
                kind: secondKind,
                amount: decimalFromCents(target.amountCents),
                currency: context.currency,
                externalReferenceTransactionId: target.externalTransactionId,
              },
            ),
          );
          expect(duplicateReversal.response.status).toBe("REJECTED");
          expect(duplicateReversal.response.failureCode).toBe(
            "REFERENCE_ALREADY_REVERSED",
          );
          expect(duplicateReversal.response.wallet?.balance).toBe(
            decimalFromCents(context.balanceCents),
          );
        }

        const crossProviderTarget = contexts.find(
          (context) =>
            context.providerId !== contexts[0]?.providerId &&
            context.processedBets.length > 0 &&
            context.currency === contexts[0]?.currency,
        )?.processedBets[0];
        const sourceContext = contexts.find(
          (context) =>
            context.providerId !== contexts[0]?.providerId &&
            context.currency === contexts[0]?.currency,
        );
        const isolatedContext = contexts.find(
          (context) =>
            context.providerId === contexts[0]?.providerId &&
            context.currency === contexts[0]?.currency,
        );
        if (
          crossProviderTarget !== undefined &&
          sourceContext !== undefined &&
          isolatedContext !== undefined
        ) {
          const crossProviderReference = await wagers.process(
            isolatedContext.providerId,
            `property-cross-provider-key-${randomUUID()}`,
            integrationContext.wagerInput(
              isolatedContext.externalPlayerId,
              `property-cross-provider-refund-${randomUUID()}`,
              {
                kind: WagerTransactionKind.REFUND,
                amount: decimalFromCents(crossProviderTarget.amountCents),
                currency: isolatedContext.currency,
                externalReferenceTransactionId:
                  crossProviderTarget.externalTransactionId,
              },
            ),
          );
          expect(crossProviderReference.response.status).toBe(
            "PENDING_REFERENCE",
          );
          expect(crossProviderReference.response.wallet?.balance).toBe(
            decimalFromCents(isolatedContext.balanceCents),
          );
        }

        const providerIds = [
          ...new Set(contexts.map((context) => context.providerId)),
        ];
        const summary = await integrationContext.orm.em.execute<
          {
            provider_id: string;
            player_id: string;
            wallet_id: string;
            currency: string;
            balance: string;
            version: number;
            ledger_balance: string;
            ledger_count: string;
            orphan_ledger_count: string;
            invalid_reference_count: string;
            duplicate_reversal_count: string;
            repeated_operation_count: string;
          }[]
        >(
          `SELECT wallet.provider_id,
              wallet.player_id,
              wallet.id AS wallet_id,
              wallet.currency,
              wallet.balance::text AS balance,
              wallet.version,
              COALESCE((
                SELECT SUM(CASE entry.entry_type
                           WHEN 'CREDIT' THEN entry.amount
                           ELSE -entry.amount END)
                FROM "${integrationContext.schema}".wallet_ledger_entries entry
                WHERE entry.wallet_id = wallet.id
              ), 0)::numeric(20, 2)::text AS ledger_balance,
              (SELECT count(*)::text FROM "${integrationContext.schema}".wallet_ledger_entries entry
               WHERE entry.wallet_id = wallet.id) AS ledger_count,
              (SELECT count(*)::text
               FROM "${integrationContext.schema}".wallet_ledger_entries entry
               LEFT JOIN "${integrationContext.schema}".wager_transactions wager
                 ON wager.id = entry.wager_transaction_id
               WHERE entry.wallet_id = wallet.id AND wager.id IS NULL)
                AS orphan_ledger_count,
              (SELECT count(*)::text FROM "${integrationContext.schema}".wager_transactions wager
               LEFT JOIN "${integrationContext.schema}".wager_transactions reference
                 ON reference.id = wager.reference_transaction_id
               WHERE wager.wallet_id = wallet.id
                 AND wager.reference_transaction_id IS NOT NULL
                 AND (reference.id IS NULL
                   OR reference.provider_id <> wager.provider_id
                   OR reference.player_id <> wager.player_id
                   OR reference.wallet_id <> wager.wallet_id
                   OR reference.currency <> wager.currency))
                AS invalid_reference_count,
              (SELECT count(*)::text FROM (
                 SELECT reference_transaction_id
                 FROM "${integrationContext.schema}".wager_transactions
                 WHERE wallet_id = wallet.id
                   AND status = 'PROCESSED'
                   AND kind IN ('REFUND', 'ROLLBACK')
                 GROUP BY reference_transaction_id
                 HAVING count(*) > 1
               ) reversals) AS duplicate_reversal_count,
              (SELECT count(*)::text FROM (
                 SELECT provider_id, external_transaction_id
                 FROM "${integrationContext.schema}".wager_transactions
                 WHERE wallet_id = wallet.id AND kind <> 'OPENING'
                 GROUP BY provider_id, external_transaction_id
                 HAVING count(*) > 1
               ) duplicates) AS repeated_operation_count
       FROM "${integrationContext.schema}".wallets wallet
       WHERE wallet.provider_id IN (?, ?)
       ORDER BY wallet.provider_id, wallet.player_id, wallet.currency`,
          [providerIds[0], providerIds[1]],
        );
        expect(summary).toHaveLength(contexts.length);
        for (const row of summary) {
          const context = contexts.find(
            (item) => item.walletId === row.wallet_id,
          );
          if (context === undefined) {
            throw new Error(`Seed ${seed}: unexpected wallet ${row.wallet_id}`);
          }
          expect(row).toMatchObject({
            provider_id: context.providerId,
            player_id: context.playerId,
            currency: context.currency,
            balance: decimalFromCents(context.balanceCents),
            ledger_balance: decimalFromCents(context.balanceCents),
            orphan_ledger_count: "0",
            invalid_reference_count: "0",
            duplicate_reversal_count: "0",
            repeated_operation_count: "0",
          });
          // Version starts at 1 with the opening credit and grows by one per
          // later Ledger entry, so it equals the total Ledger entry count.
          expect(row.version).toBe(Number(row.ledger_count));
          expect(BigInt(row.balance.replace(".", ""))).toBeGreaterThanOrEqual(
            0n,
          );
          await integrationContext.expectWalletBalanceMatchesLedger(
            row.wallet_id,
          );
        }
        expect(
          await integrationContext.orm.em.execute<{ count: string }[]>(
            `SELECT count(*)::text AS count
         FROM "${integrationContext.schema}".financial_operations operation
         JOIN "${integrationContext.schema}".wager_transactions wager
           ON wager.financial_operation_id = operation.id
         WHERE wager.provider_id IN (?, ?)
           AND operation.provider_id <> wager.provider_id`,
            [providerIds[0], providerIds[1]],
          ),
        ).toEqual([{ count: "0" }]);
      });
    });
  },
);
