import { describe, expect, test } from "bun:test";
import { validateEnvironment } from "../../src/config/env.validation.js";
import {
  openWalletRequestDto,
  submitWagerTransactionDto,
} from "../../src/modules/http-api/dto/wagering-api.dto.js";
import {
  registerPlayerDto,
  updatePlayerStatusDto,
} from "../../src/modules/players/dto/players.dto.js";
import {
  registerProviderDto,
  updateProviderStatusDto,
} from "../../src/modules/providers/dto/providers.dto.js";

describe("HTTP API DTOs", () => {
  test("maps provider registration and status request bodies", () => {
    expect(
      registerProviderDto({ code: "provider-1", name: "Provider" }),
    ).toEqual({
      code: "provider-1",
      name: "Provider",
    });
    expect(updateProviderStatusDto({ status: "ACTIVE" })).toEqual({
      status: "ACTIVE",
    });
    expect(() => registerProviderDto(null)).toThrow(
      "Request body must be an object",
    );
    expect(() => registerProviderDto({ code: 123, name: "Provider" })).toThrow(
      "code must be a string",
    );
    expect(() => updateProviderStatusDto({ status: false })).toThrow(
      "status must be a string",
    );
  });

  test("maps the POST /wallets body of the contract", () => {
    expect(
      openWalletRequestDto({
        playerId: "player-uuid",
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    ).toEqual({
      playerId: "player-uuid",
      initialBalance: { amount: "100.00", currency: "BRL" },
    });
    expect(() =>
      openWalletRequestDto({
        playerId: "player-uuid",
        initialBalance: { amount: "100.00", currency: "BRL" },
        balance: "1",
      }),
    ).toThrow("Unsupported request field: balance");
    expect(() => openWalletRequestDto({ playerId: "p" })).toThrow(
      "initialBalance must be an object",
    );
  });

  test("maps player registration and status request bodies", () => {
    expect(registerPlayerDto({ externalPlayerId: "player-1" })).toEqual({
      externalPlayerId: "player-1",
    });
    expect(updatePlayerStatusDto({ status: "SUSPENDED" })).toEqual({
      status: "SUSPENDED",
    });
    expect(() => registerPlayerDto(null)).toThrow(
      "Request body must be an object",
    );
    expect(() => registerPlayerDto({ externalPlayerId: 123 })).toThrow(
      "externalPlayerId must be a string",
    );
    expect(() => updatePlayerStatusDto({})).toThrow("status must be a string");
    expect(() => registerPlayerDto([])).toThrow(
      "Request body must be an object",
    );
  });

  test("maps the POST /wagering/transactions body of the contract", () => {
    const body = {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: "player-uuid",
      walletId: "wallet-uuid",
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    } as const;
    expect(submitWagerTransactionDto(body)).toEqual(body);
    expect(
      submitWagerTransactionDto({
        ...body,
        kind: "WIN",
        referenceExternalTransactionId: "transaction-122",
      }).referenceExternalTransactionId,
    ).toBe("transaction-122");
  });

  test("refuses OPENING, unknown fields and malformed money", () => {
    const body = {
      externalTransactionId: "tx-1",
      playerId: "p",
      walletId: "w",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    };
    expect(() =>
      submitWagerTransactionDto({ ...body, kind: "OPENING" }),
    ).toThrow("kind must be one of");
    expect(() => submitWagerTransactionDto({ ...body, extra: 1 })).toThrow(
      "Unsupported request field: extra",
    );
    expect(() =>
      submitWagerTransactionDto({ ...body, money: { amount: "1.00" } }),
    ).toThrow("money.currency must be a non-empty string");
  });
});

describe("provider API key configuration", () => {
  test("parses a provider code to secret map", () => {
    const secret = "s".repeat(40);
    const environment = validateEnvironment({
      PROVIDER_API_KEYS: JSON.stringify({ providerA: secret }),
    });

    expect(environment.PROVIDER_API_KEYS).toEqual({ providerA: secret });
  });

  test("rejects malformed, weak, or non-object key configuration", () => {
    expect(() =>
      validateEnvironment({ PROVIDER_API_KEYS: "not-json" }),
    ).toThrow("PROVIDER_API_KEYS must be a JSON object");
    expect(() =>
      validateEnvironment({
        PROVIDER_API_KEYS: JSON.stringify({ providerA: "short" }),
      }),
    ).toThrow("API keys of at least 32 characters");
    expect(() => validateEnvironment({ PROVIDER_API_KEYS: "[]" })).toThrow(
      "PROVIDER_API_KEYS must be a JSON object",
    );
    expect(() =>
      validateEnvironment({ PROVIDER_ADMIN_API_KEY: "short" }),
    ).toThrow(
      "PROVIDER_ADMIN_API_KEY must be empty or contain at least 32 characters",
    );
  });
});
