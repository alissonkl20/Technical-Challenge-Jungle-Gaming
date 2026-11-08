import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import {
  DomainError,
  DuplicatePlayerError,
  DuplicateWalletError,
  FinancialOperationNotFoundError,
  IdempotencyConflictError,
  IdempotencyReplayError,
  InactivePlayerError,
  InactiveProviderError,
  PlayerNotFoundError,
  ProviderAlreadyExistsError,
  ProviderNotFoundError,
  WagerTransactionNotFoundError,
  WalletNotFoundError,
} from "../../modules/finance/domain/index.js";
import { errorStack, hasErrorCode } from "./error-chain.js";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? normalizeMessage(payload.message)
          : typeof payload === "string"
            ? payload
            : exception.message;
      const code =
        typeof payload === "object" &&
        payload !== null &&
        "code" in payload &&
        typeof payload.code === "string"
          ? payload.code
          : exception.name;
      response.status(status).json({
        statusCode: status,
        error: exception.name,
        code,
        message,
      });
      return;
    }

    if (exception instanceof DomainError) {
      const status = domainStatus(exception);
      response.status(status).json({
        statusCode: status,
        error: exception.name,
        code: exception.name
          .replace(/Error$/, "")
          .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
          .toUpperCase(),
        message: exception.message,
      });
      return;
    }

    if (isTransientInfrastructureError(exception)) {
      this.logger.warn("Transient HTTP dependency failure");
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: "ServiceUnavailableException",
        code: "DEPENDENCY_UNAVAILABLE",
        message: "A required dependency is temporarily unavailable",
      });
      return;
    }

    if (isRequestEntityTooLargeError(exception)) {
      response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        error: "PayloadTooLargeException",
        code: "REQUEST_TOO_LARGE",
        message: "Request body exceeds the allowed size",
      });
      return;
    }

    this.logger.error("Unhandled HTTP request error", errorStack(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "InternalServerError",
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    });
  }
}

function isRequestEntityTooLargeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large" &&
    "status" in error &&
    error.status === HttpStatus.PAYLOAD_TOO_LARGE
  );
}

/** PostgreSQL SQLSTATEs and socket errors that a retry may resolve. */
const TRANSIENT_INFRASTRUCTURE_CODES: ReadonlySet<string> = new Set([
  "08000",
  "08003",
  "08006",
  "40001",
  "40P01",
  "53300",
  "57P01",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
]);

function isTransientInfrastructureError(error: unknown): boolean {
  return hasErrorCode(error, TRANSIENT_INFRASTRUCTURE_CODES);
}

function normalizeMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join("; ");
  }
  return "Request failed";
}

function domainStatus(exception: DomainError): number {
  if (
    exception instanceof ProviderNotFoundError ||
    exception instanceof PlayerNotFoundError ||
    exception instanceof WalletNotFoundError ||
    exception instanceof FinancialOperationNotFoundError ||
    exception instanceof WagerTransactionNotFoundError
  ) {
    return HttpStatus.NOT_FOUND;
  }
  if (
    exception instanceof ProviderAlreadyExistsError ||
    exception instanceof DuplicatePlayerError ||
    exception instanceof DuplicateWalletError ||
    exception instanceof IdempotencyConflictError ||
    exception instanceof IdempotencyReplayError
  ) {
    return HttpStatus.CONFLICT;
  }
  if (
    exception instanceof InactiveProviderError ||
    exception instanceof InactivePlayerError
  ) {
    return HttpStatus.UNPROCESSABLE_ENTITY;
  }
  return HttpStatus.BAD_REQUEST;
}
