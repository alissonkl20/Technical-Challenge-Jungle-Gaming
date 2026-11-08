import { isRecord, trimmedText } from "../../shared/validation/index.js";
import { WagerTransactionKind } from "../finance/domain/index.js";
import { PermanentSqsMessageError } from "./errors/index.js";
import type { WagerCommand } from "./types/index.js";

/** Parses a `WagerTransactionRequested` body; anything malformed is permanent. */
export function parseWagerCommand(body: string | undefined): WagerCommand {
  if (body === undefined) {
    throw new PermanentSqsMessageError("SQS wager command has no body");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PermanentSqsMessageError("SQS wager command is not valid JSON");
  }
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new PermanentSqsMessageError("SQS wager command envelope is invalid");
  }
  if (value.type !== "WagerTransactionRequested") {
    throw new PermanentSqsMessageError("Unsupported SQS wager command type");
  }

  const data = value.data;
  const correlationId = trimmedText(value.correlationId);
  return {
    messageId: requiredText(value.messageId, "messageId"),
    ...(correlationId === undefined ? {} : { correlationId }),
    type: "WagerTransactionRequested",
    data: {
      providerId: requiredText(data.providerId, "providerId"),
      idempotencyKey: requiredText(data.idempotencyKey, "idempotencyKey"),
      playerId: requiredText(data.playerId, "playerId"),
      walletId: requiredText(data.walletId, "walletId"),
      input: parseWagerInput(data),
    },
  };
}

function parseWagerInput(
  data: Record<string, unknown>,
): WagerCommand["data"]["input"] {
  const kind = externalKind(requiredText(data.kind, "kind"));
  if (!isRecord(data.money)) {
    throw new PermanentSqsMessageError("money must be an object");
  }
  return {
    externalTransactionId: requiredText(
      data.externalTransactionId,
      "externalTransactionId",
    ),
    kind,
    amount: requiredText(data.money.amount, "money.amount"),
    currency: requiredText(data.money.currency, "money.currency"),
    ...(data.referenceExternalTransactionId === undefined
      ? {}
      : {
          externalReferenceTransactionId: requiredText(
            data.referenceExternalTransactionId,
            "referenceExternalTransactionId",
          ),
        }),
    ...(data.roundId === undefined
      ? {}
      : { roundId: requiredText(data.roundId, "roundId") }),
    ...(data.gameId === undefined
      ? {}
      : { gameId: requiredText(data.gameId, "gameId") }),
  };
}

function externalKind(rawKind: string): WagerTransactionKind {
  const kind = Object.values(WagerTransactionKind).find(
    (candidate) => candidate === rawKind,
  );
  if (kind === undefined || kind === WagerTransactionKind.OPENING) {
    throw new PermanentSqsMessageError(
      "Invalid external wager transaction kind",
    );
  }
  return kind;
}

function requiredText(value: unknown, field: string): string {
  const text = trimmedText(value);
  if (text === undefined) {
    throw new PermanentSqsMessageError(`${field} must be a non-empty string`);
  }
  return text;
}
