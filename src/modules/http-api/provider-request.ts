import { ForbiddenException } from "@nestjs/common";
import { identifiesProvider } from "../auth/provider-auth.service.js";
import type {
  AuthenticatedProvider,
  ProviderAuthenticatedRequest,
} from "../auth/types/index.js";

export function authenticatedProvider(
  request: ProviderAuthenticatedRequest,
): AuthenticatedProvider {
  if (request.provider === undefined) {
    throw new Error(
      "Provider API guard did not attach an authenticated provider",
    );
  }

  return request.provider;
}

/** A body may name a provider only when it is the authenticated one. */
export function assertSubmitsForAuthenticatedProvider(
  bodyProviderId: string | undefined,
  provider: AuthenticatedProvider,
): void {
  if (
    bodyProviderId !== undefined &&
    !identifiesProvider(bodyProviderId, provider)
  ) {
    throw new ForbiddenException({
      code: "PROVIDER_SCOPE_MISMATCH",
      message: "The authenticated provider cannot submit for another provider",
    });
  }
}
