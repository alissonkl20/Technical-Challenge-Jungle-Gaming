/**
 * Whether the error, or any error in its `cause` chain, carries one of the
 * codes. Drivers wrap the PostgreSQL error, so the SQLSTATE is rarely on the
 * outermost object. Cycles in the chain are tolerated.
 */
export function hasErrorCode(
  error: unknown,
  codes: ReadonlySet<string>,
): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !visited.has(current)
  ) {
    visited.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      codes.has(current.code)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

/** Human-readable text of any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A log-safe error identifier: the class name, never the message. */
export function errorCodeOf(error: unknown): string {
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

/** The stack trace for an operator log, or the value itself when not an Error. */
export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : String(error);
}
