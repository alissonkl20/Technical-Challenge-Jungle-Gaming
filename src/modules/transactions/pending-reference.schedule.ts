import { exponentialBackoff } from "../../shared/retry/exponential-backoff.js";

const MAX_RETRY_DELAY_MS = 3_600_000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Delay before the next attempt to resolve a pending reference: the initial
 * delay doubled per attempt already made, capped at one hour.
 */
export function pendingReferenceRetryDelayMs(
  initialDelayMs: number,
  attempts: number,
): number {
  return exponentialBackoff(initialDelayMs, attempts, {
    maxExponent: 10,
    maxDelay: MAX_RETRY_DELAY_MS,
  });
}

/** When a reference first found missing at `now` stops being awaited. */
export function pendingReferenceExpiry(now: Date, ttlHours: number): Date {
  return new Date(now.getTime() + ttlHours * HOUR_MS);
}
