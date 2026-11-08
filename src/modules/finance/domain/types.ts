import { DomainError } from "./errors.js";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type CurrencyCode = Brand<string, "CurrencyCode">;
export type WalletId = Brand<string, "WalletId">;
export type PlayerId = Brand<string, "PlayerId">;
export type ProviderId = Brand<string, "ProviderId">;
export type WagerTransactionId = Brand<string, "WagerTransactionId">;
export type FinancialOperationId = Brand<string, "FinancialOperationId">;
export type LedgerEntryId = Brand<string, "LedgerEntryId">;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid<Value extends string>(value: string, field: string): Value {
  if (!UUID_PATTERN.test(value)) {
    throw new DomainError(`${field} must be a valid UUID`);
  }

  return value as Value;
}

export function currencyCode(value: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new DomainError("Currency must be a three-letter uppercase code");
  }

  return value as CurrencyCode;
}

export const walletId = (value: string): WalletId => uuid(value, "walletId");
export const playerId = (value: string): PlayerId => uuid(value, "playerId");
export const providerId = (value: string): ProviderId =>
  uuid(value, "providerId");
export const wagerTransactionId = (value: string): WagerTransactionId =>
  uuid(value, "transactionId");
export const financialOperationId = (value: string): FinancialOperationId =>
  uuid(value, "financialOperationId");
export const ledgerEntryId = (value: string): LedgerEntryId =>
  uuid(value, "ledgerEntryId");
