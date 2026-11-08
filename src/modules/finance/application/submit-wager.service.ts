import { Inject, Injectable } from "@nestjs/common";
import {
  assertReplayAddressesWallet,
  resolveSubmittedWagerIdentity,
} from "../../transactions/wager-submission-identity.js";
import { WagerTransactionsService } from "../../transactions/wager-transactions.service.js";
import type { WagerTransactionKind } from "../domain/index.js";
import type { TransactionManager } from "../persistence/repositories.js";
import { TRANSACTION_MANAGER } from "../persistence/tokens.js";
import type { SubmitWagerCommand, SubmitWagerOutcome } from "./types/index.js";

/**
 * Resolves the identifiers the published contract exposes (`playerId`,
 * `walletId`) and then delegates to the one wager use case shared with the SQS
 * consumer.
 *
 * The resolution happens **inside the same SQL transaction** that applies the
 * movement. Reading the wallet in an earlier transaction would let it be
 * closed or re-denominated in between, so the currency check would be made
 * against a wallet that no longer exists in that form.
 */
@Injectable()
export class SubmitWagerService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
    @Inject(WagerTransactionsService)
    private readonly wagers: WagerTransactionsService,
  ) {}

  submit(
    providerId: string,
    idempotencyKey: string,
    command: SubmitWagerCommand,
  ): Promise<SubmitWagerOutcome> {
    return this.transactions.transaction(async (session) => {
      // Resolution is read-only and shared with the SQS consumer. Whatever it
      // finds is handed to the wager use case, which records a rejection
      // through the idempotency reservation, so an unknown player or wallet is
      // answered and replayed like any other business rejection.
      const { externalPlayerId, rejection } =
        await resolveSubmittedWagerIdentity(session, providerId, {
          playerId: command.playerId,
          walletId: command.walletId,
          currency: command.money.currency,
        });

      const result = await this.wagers.process(
        providerId,
        idempotencyKey,
        {
          externalPlayerId,
          externalTransactionId: command.externalTransactionId,
          kind: command.kind as WagerTransactionKind,
          amount: command.money.amount,
          currency: command.money.currency,
          ...(command.referenceExternalTransactionId === undefined
            ? {}
            : {
                externalReferenceTransactionId:
                  command.referenceExternalTransactionId,
              }),
          ...(command.roundId === undefined
            ? {}
            : { roundId: command.roundId }),
          ...(command.gameId === undefined ? {} : { gameId: command.gameId }),
          ...(rejection === undefined ? {} : { rejection }),
        },
        session,
      );
      assertReplayAddressesWallet(result, idempotencyKey, command.walletId);

      const walletSnapshot = result.response.wallet;
      return {
        httpStatus: result.httpStatus,
        transactionId: result.response.transaction?.id ?? null,
        externalTransactionId: result.response.externalTransactionId,
        status: result.response.status,
        balance:
          walletSnapshot === null
            ? null
            : {
                amount: walletSnapshot.balance,
                currency: walletSnapshot.currency,
              },
        failureCode: result.response.failureCode,
        idempotentReplay: result.idempotentReplay,
      };
    });
  }
}
