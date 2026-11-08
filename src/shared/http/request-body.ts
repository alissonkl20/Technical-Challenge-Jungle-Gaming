import { BadRequestException } from "@nestjs/common";
import { isRecord } from "../validation/index.js";

export function requestObjectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new BadRequestException("Request body must be an object");
  }

  return body;
}

export function requiredStringField(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${field} must be a string`);
  }

  return value;
}
