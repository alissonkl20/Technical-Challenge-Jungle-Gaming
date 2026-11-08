import {
  requestObjectBody,
  requiredStringField,
} from "../../../shared/http/request-body.js";
import type { RegisterProviderInput } from "../types/index.js";

export interface UpdateProviderStatusDto {
  readonly status: string;
}

export function registerProviderDto(body: unknown): RegisterProviderInput {
  const request = requestObjectBody(body);

  return {
    code: requiredStringField(request.code, "code"),
    name: requiredStringField(request.name, "name"),
  };
}

export function updateProviderStatusDto(
  body: unknown,
): UpdateProviderStatusDto {
  const request = requestObjectBody(body);

  return {
    status: requiredStringField(request.status, "status"),
  };
}
