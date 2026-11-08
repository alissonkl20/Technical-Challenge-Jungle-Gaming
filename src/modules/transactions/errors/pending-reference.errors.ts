/**
 * A pending reference that can never be resumed: its stored context is
 * inconsistent, so retrying cannot change the outcome.
 *
 * This is the only path to the FAILED state. Transient infrastructure errors
 * are not this error and keep their backoff, and business rejections use
 * REJECTED with a business failure code.
 */
export class PermanentReferenceError extends Error {
  override readonly name = "PermanentReferenceError";
}
