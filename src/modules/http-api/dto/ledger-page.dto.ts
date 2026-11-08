import { BadRequestException } from "@nestjs/common";
import type { LedgerCursor } from "../../finance/application/types/index.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Ledger pages use an opaque keyset cursor over `(created_at, id)` so that a
 * page stays stable while new entries are appended. The cursor is opaque by
 * design: providers must not build one, so its contents stay free to change.
 */
export function decodeLedgerCursor(
  value: string | undefined,
): LedgerCursor | null {
  if (value === undefined) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    // The timestamp may itself contain no newline, so the last one separates
    // the two parts unambiguously.
    const separator = decoded.lastIndexOf("\n");
    if (separator <= 0) {
      throw new Error("cursor has no separator");
    }
    const createdAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (Number.isNaN(Date.parse(createdAt)) || !UUID_PATTERN.test(id)) {
      throw new Error("cursor has invalid parts");
    }
    return { createdAt, id };
  } catch {
    throw new BadRequestException({
      code: "INVALID_CURSOR",
      message: "cursor is invalid",
    });
  }
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(`${cursor.createdAt}\n${cursor.id}`).toString("base64url");
}

export function parseLedgerLimit(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException({
      code: "INVALID_LIMIT",
      message: `limit must be an integer from 1 to ${MAX_LIMIT}`,
    });
  }
  const limit = Number(value);
  if (limit > MAX_LIMIT) {
    throw new BadRequestException({
      code: "INVALID_LIMIT",
      message: `limit must be an integer from 1 to ${MAX_LIMIT}`,
    });
  }
  return limit;
}
