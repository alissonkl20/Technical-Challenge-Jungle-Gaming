import { isRecord } from "../../shared/validation/index.js";
import { PermanentSqsMessageError } from "./errors/index.js";
import type { FinancialEventEnvelope } from "./types/index.js";

/**
 * Accepts the versioned envelope (`eventId`, `eventType`, ...) and the legacy
 * snake_case one. A versioned envelope must also carry version 1, a
 * correlation ID and a parseable `occurredAt`.
 */
export function parseFinancialEventEnvelope(
  body: string | undefined,
): FinancialEventEnvelope {
  if (body === undefined) {
    throw new PermanentSqsMessageError("SQS message has no body");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PermanentSqsMessageError("SQS message body is not valid JSON");
  }
  if (!isRecord(value)) {
    throw invalidEnvelope();
  }
  const eventId = value.eventId ?? value.event_id;
  const eventType = value.eventType ?? value.event_type;
  const aggregateId = value.aggregateId ?? value.aggregate_id;
  const payload = value.data ?? value.payload;
  if (
    !isNonBlankString(eventId) ||
    !isNonBlankString(eventType) ||
    !isNonBlankString(aggregateId) ||
    payload === undefined ||
    ("eventId" in value && !hasValidVersionedFields(value))
  ) {
    throw invalidEnvelope();
  }
  return {
    event_id: eventId,
    event_type: eventType,
    aggregate_id: aggregateId,
    payload,
    ...(typeof value.correlationId === "string"
      ? { correlation_id: value.correlationId }
      : {}),
  };
}

/** The string value of a payload field, or null when absent or not a string. */
export function payloadStringField(
  payload: unknown,
  field: string,
): string | null {
  if (isRecord(payload) && field in payload) {
    const value = payload[field];
    return typeof value === "string" ? value : null;
  }
  return null;
}

function hasValidVersionedFields(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    isNonBlankString(value.correlationId) &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt))
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidEnvelope(): PermanentSqsMessageError {
  return new PermanentSqsMessageError(
    "SQS message has an invalid event envelope",
  );
}
