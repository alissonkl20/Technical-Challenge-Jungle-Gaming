import {
  requestObjectBody,
  requiredStringField,
} from "../../../shared/http/request-body.js";
import type { RegisterPlayerInput } from "../types/index.js";

export interface UpdatePlayerStatusDto {
  readonly status: string;
}

export function registerPlayerDto(body: unknown): RegisterPlayerInput {
  const request = requestObjectBody(body);

  return {
    externalPlayerId: requiredStringField(
      request.externalPlayerId,
      "externalPlayerId",
    ),
  };
}

export function updatePlayerStatusDto(body: unknown): UpdatePlayerStatusDto {
  const request = requestObjectBody(body);

  return {
    status: requiredStringField(request.status, "status"),
  };
}
