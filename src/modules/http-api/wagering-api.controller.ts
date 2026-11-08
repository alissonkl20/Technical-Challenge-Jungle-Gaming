import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { ProviderApiKeyGuard } from "../auth/provider-auth.guard.js";
import type { ProviderAuthenticatedRequest } from "../auth/types/index.js";
import { FinanceQueriesService } from "../finance/application/finance-queries.service.js";
import { SubmitWagerService } from "../finance/application/submit-wager.service.js";
import { WalletsService } from "../wallets/wallets.service.js";
import {
  decodeLedgerCursor,
  idempotencyKeyHeader,
  ledgerPageDto,
  openedWalletDto,
  openWalletRequestDto,
  operationAsTransactionDto,
  parseLedgerLimit,
  submittedTransactionDto,
  submitWagerTransactionDto,
  transactionDto,
  walletDto,
} from "./dto/index.js";
import {
  assertSubmitsForAuthenticatedProvider,
  authenticatedProvider,
} from "./provider-request.js";

/**
 * The provider-facing contract: wallet lifecycle, wager submission, and the
 * read models providers reconcile against.
 */
@UseGuards(ProviderApiKeyGuard)
@Controller()
export class WageringApiController {
  constructor(
    @Inject(SubmitWagerService)
    private readonly submission: SubmitWagerService,
    @Inject(WalletsService)
    private readonly wallets: WalletsService,
    @Inject(FinanceQueriesService)
    private readonly queries: FinanceQueriesService,
  ) {}

  @Post("wallets")
  @HttpCode(HttpStatus.CREATED)
  async openWallet(
    @Req() request: ProviderAuthenticatedRequest,
    @Body() body: unknown,
  ) {
    const input = openWalletRequestDto(body);
    const wallet = await this.wallets.open(
      authenticatedProvider(request).id,
      input.playerId,
      input.initialBalance.currency,
      input.initialBalance,
    );
    return openedWalletDto(wallet.snapshot());
  }

  @Get("wallets/:walletId")
  async getWallet(
    @Req() request: ProviderAuthenticatedRequest,
    @Param("walletId") walletId: string,
  ) {
    return walletDto(
      await this.queries.findWalletById(
        authenticatedProvider(request),
        walletId,
      ),
    );
  }

  @Get("wallets/:walletId/ledger")
  async getWalletLedger(
    @Req() request: ProviderAuthenticatedRequest,
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const pageLimit = parseLedgerLimit(limit);
    const page = await this.queries.listLedgerPageByWallet(
      authenticatedProvider(request),
      walletId,
      pageLimit,
      decodeLedgerCursor(cursor),
    );
    return ledgerPageDto(page, pageLimit);
  }

  /** Runs a check and creates no resource, so it answers 200, not 201. */
  @Post("wallets/:walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  reconcileWallet(
    @Req() request: ProviderAuthenticatedRequest,
    @Param("walletId") walletId: string,
  ) {
    return this.queries.reconcileWallet(
      authenticatedProvider(request),
      walletId,
    );
  }

  /**
   * The status code depends on the outcome (200 processed, 202 pending
   * reference, 422 rejected), so it is set from the use case's result.
   */
  @Post("wagering/transactions")
  async submitTransaction(
    @Req() request: ProviderAuthenticatedRequest,
    @Headers("idempotency-key") idempotencyKey: string | string[] | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const key = idempotencyKeyHeader(idempotencyKey);
    const provider = authenticatedProvider(request);
    const command = submitWagerTransactionDto(body);
    assertSubmitsForAuthenticatedProvider(command.providerId, provider);

    const outcome = await this.submission.submit(provider.id, key, command);
    response.status(outcome.httpStatus);
    return submittedTransactionDto(outcome);
  }

  @Get("wagering/transactions/:transactionId")
  async getTransaction(
    @Req() request: ProviderAuthenticatedRequest,
    @Param("transactionId") transactionId: string,
  ) {
    return transactionDto(
      await this.queries.findTransactionById(
        authenticatedProvider(request),
        transactionId,
      ),
    );
  }

  /** `:providerId` is checked and normalized by `ProviderApiKeyGuard`. */
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getTransactionByExternalId(
    @Req() request: ProviderAuthenticatedRequest,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    const scope = authenticatedProvider(request);
    const lookup = await this.queries.findTransactionOrOperationByExternalId(
      scope,
      externalTransactionId,
    );
    return lookup.kind === "transaction"
      ? transactionDto(lookup.transaction)
      : operationAsTransactionDto(scope.id, lookup.operation);
  }
}
