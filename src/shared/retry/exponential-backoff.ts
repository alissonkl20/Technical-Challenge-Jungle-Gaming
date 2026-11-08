export interface ExponentialBackoffBounds {
  /** Caps the doubling, so a large attempt count cannot overflow the delay. */
  readonly maxExponent: number;
  readonly maxDelay: number;
}

/** `base * 2^attempt`, with the exponent and the result both capped. */
export function exponentialBackoff(
  baseDelay: number,
  attempt: number,
  bounds: ExponentialBackoffBounds,
): number {
  const exponent = Math.min(Math.max(attempt, 0), bounds.maxExponent);
  return Math.min(baseDelay * 2 ** exponent, bounds.maxDelay);
}
