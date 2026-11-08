import { BadRequestException } from "@nestjs/common";
import { isRecord, trimmedText } from "../../../shared/validation/index.js";
import {
  WagerTransactionKind,
  type WagerTransactionKind as WagerTransactionKindType,
} from "../../finance/domain/index.js";

/** Body of `POST /wagering/transactions`, as published in the provider contract. */
export interface SubmitWagerTransactionDto {
  readonly providerId?: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly kind: WagerTransactionKindType;
  readonly money: { readonly amount: string; readonly currency: string };
  readonly referenceExternalTransactionId?: string;
  readonly roundId?: string;
  readonly gameId?: string;
}

/** Body of `POST /wallets`. */
export interface OpenWalletRequestDto {
  readonly playerId: string;
  readonly initialBalance: {
    readonly amount: string;
    readonly currency: string;
  };
}

const TRANSACTION_FIELDS = new Set([
  "providerId",
  "externalTransactionId",
  "playerId",
  "walletId",
  "kind",
  "money",
  "referenceExternalTransactionId",
  "roundId",
  "gameId",
]);
const WALLET_FIELDS = new Set(["playerId", "initialBalance"]);
const MONEY_FIELDS = new Set(["amount", "currency"]);
const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.BET,
  WagerTransactionKind.WIN,
  WagerTransactionKind.LOSS,
  WagerTransactionKind.REFUND,
  WagerTransactionKind.ROLLBACK,
]);

/** The `Idempotency-Key` header, required on every wager submission. */
export function idempotencyKeyHeader(
  value: string | string[] | undefined,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestException({
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "Idempotency-Key header is required",
    });
  }
  return value;
}

export function submitWagerTransactionDto(
  body: unknown,
): SubmitWagerTransactionDto {
  const input = objectBody(body);
  assertKnownFields(input, TRANSACTION_FIELDS);
  const kind = requiredString(input.kind, "kind");
  if (!SUBMITTABLE_KINDS.has(kind)) {
    // OPENING is internal: it can never be submitted through the API.
    throw invalidPayload(
      `kind must be one of ${[...SUBMITTABLE_KINDS].join(", ")}`,
    );
  }

  return {
    ...optionalString(input, "providerId"),
    externalTransactionId: requiredString(
      input.externalTransactionId,
      "externalTransactionId",
    ),
    playerId: requiredString(input.playerId, "playerId"),
    walletId: requiredString(input.walletId, "walletId"),
    kind: kind as WagerTransactionKindType,
    money: moneyField(input.money, "money"),
    ...optionalString(input, "referenceExternalTransactionId"),
    ...optionalString(input, "roundId"),
    ...optionalString(input, "gameId"),
  };
}

export function openWalletRequestDto(body: unknown): OpenWalletRequestDto {
  const input = objectBody(body);
  assertKnownFields(input, WALLET_FIELDS);
  return {
    playerId: requiredString(input.playerId, "playerId"),
    initialBalance: moneyField(input.initialBalance, "initialBalance"),
  };
}

function moneyField(
  value: unknown,
  field: string,
): { readonly amount: string; readonly currency: string } {
  if (!isRecord(value)) {
    throw invalidPayload(`${field} must be an object`);
  }
  assertKnownFields(value, MONEY_FIELDS, field);
  return {
    amount: requiredString(value.amount, `${field}.amount`),
    currency: requiredString(value.currency, `${field}.currency`),
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidPayload("Request body must be an object");
  }
  return value;
}

function assertKnownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix?: string,
): void {
  const unknownField = Object.keys(value).find((field) => !allowed.has(field));
  if (unknownField !== undefined) {
    throw invalidPayload(
      `Unsupported request field: ${prefix === undefined ? unknownField : `${prefix}.${unknownField}`}`,
    );
  }
}

function requiredString(value: unknown, field: string): string {
  const text = trimmedText(value);
  if (text === undefined) {
    throw invalidPayload(`${field} must be a non-empty string`);
  }
  return text;
}

function optionalString(
  input: Record<string, unknown>,
  field: "providerId" | "referenceExternalTransactionId" | "roundId" | "gameId",
): Record<string, string> {
  const value = input[field];
  if (value === undefined) {
    return {};
  }
  return { [field]: requiredString(value, field) };
}

function invalidPayload(message: string): BadRequestException {
  return new BadRequestException({ code: "INVALID_PAYLOAD", message });
}
