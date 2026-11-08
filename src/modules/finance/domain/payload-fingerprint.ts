import { createHash } from "node:crypto";
import { InvalidPayloadError } from "./errors.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Canonical JSON form: object keys sorted, so two payloads that differ only in
 * key order produce one digest. Without it, a provider retrying the same
 * request with reordered fields would read as a payload conflict.
 */
function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidPayloadError("Payload numbers must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new InvalidPayloadError(
        "Payload cannot contain circular references",
      );
    }
    ancestors.add(value);
    const items = value.map((item) => canonicalize(item, ancestors));
    ancestors.delete(value);
    return items;
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new InvalidPayloadError(
        "Payload cannot contain circular references",
      );
    }
    ancestors.add(value);
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      // An absent key and an explicit `undefined` must hash alike, because
      // JSON transport cannot tell them apart.
      if (entry !== undefined) {
        result[key] = canonicalize(entry, ancestors);
      }
    }
    ancestors.delete(value);
    return result;
  }
  throw new InvalidPayloadError("Payload must contain only JSON values");
}

/**
 * The SHA-256 digest of a canonicalized request payload, and the single place
 * that knows how two payloads are compared.
 *
 * Idempotency rests on this comparison: a replay of a stored key with a
 * different payload must be rejected, never silently served. The digest is
 * stored as hex and compared case-insensitively, since a digest read back from
 * PostgreSQL may differ in case from one computed here.
 */
export class PayloadFingerprint {
  private constructor(private readonly digest: string) {
    Object.freeze(this);
  }

  /** Hashes a payload. Objects are key-sorted first; see `canonicalize`. */
  static of(payload: unknown): PayloadFingerprint {
    const canonical = JSON.stringify(canonicalize(payload, new Set()));
    return new PayloadFingerprint(
      createHash("sha256").update(canonical).digest("hex"),
    );
  }

  /** Reads a digest back from persistence or from a transport header. */
  static fromDigest(value: string): PayloadFingerprint {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
      throw new InvalidPayloadError(
        "Payload fingerprint must be a SHA-256 hex digest",
      );
    }
    return new PayloadFingerprint(value.toLowerCase());
  }

  /** `null` and malformed digests yield `null` instead of throwing. */
  static fromNullableDigest(value: string | null): PayloadFingerprint | null {
    if (value === null || !DIGEST_PATTERN.test(value)) {
      return null;
    }
    return new PayloadFingerprint(value.toLowerCase());
  }

  static isDigest(value: unknown): boolean {
    return typeof value === "string" && DIGEST_PATTERN.test(value);
  }

  equals(other: PayloadFingerprint | null): boolean {
    return other !== null && this.digest === other.digest;
  }

  /** Compares against a digest as stored. An unreadable one never matches. */
  matchesDigest(value: string | null): boolean {
    return this.equals(PayloadFingerprint.fromNullableDigest(value));
  }

  toString(): string {
    return this.digest;
  }

  toJSON(): string {
    return this.digest;
  }
}
