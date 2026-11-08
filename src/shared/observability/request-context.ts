import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  readonly correlationId: string;
  /** The message or event that caused the work running in this context. */
  readonly causationId: string | null;
}

const requestContext = new AsyncLocalStorage<RequestContext>();
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Runs `callback` under a correlation identifier. The supplied identifier is
 * kept when it is well formed; otherwise a new one is generated. Nested calls
 * replace the context, so the innermost caller decides the identifiers.
 *
 * `correlationId` names the business flow. `causationId` names the immediate
 * cause, such as an SQS message ID or an event ID. Neither is derived from the
 * other: a message ID must never stand in for a correlation ID.
 */
export function withCorrelationId<Result>(
  suppliedId: string | undefined,
  callback: () => Result,
  causationId?: string,
): Result {
  const correlationId =
    suppliedId !== undefined && IDENTIFIER_PATTERN.test(suppliedId)
      ? suppliedId
      : crypto.randomUUID();
  const cause =
    causationId !== undefined && IDENTIFIER_PATTERN.test(causationId)
      ? causationId
      : null;
  return requestContext.run({ correlationId, causationId: cause }, callback);
}

export function currentCorrelationId(): string | null {
  return requestContext.getStore()?.correlationId ?? null;
}

export function currentCausationId(): string | null {
  return requestContext.getStore()?.causationId ?? null;
}
