import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { PROVIDER_IDENTITY } from "./auth.tokens.js";
import { identifiesProvider } from "./provider-auth.service.js";
import type {
  ProviderAuthenticatedRequest,
  ProviderIdentityPort,
} from "./types/index.js";

/**
 * Authenticates the caller through `ProviderIdentityPort` and confines it to
 * its own provider scope. The credential mechanism lives entirely behind the
 * port, so this guard stays the same when API keys give way to OIDC tokens.
 */
@Injectable()
export class ProviderApiKeyGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY)
    private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ProviderAuthenticatedRequest>();
    const provider = await this.identity.identify(request.headers);
    if (
      (request.params.providerId !== undefined &&
        !identifiesProvider(request.params.providerId, provider)) ||
      (request.params.code !== undefined &&
        request.params.code !== provider.code)
    ) {
      throw new ForbiddenException({
        code: "PROVIDER_SCOPE_MISMATCH",
        message: "The authenticated provider cannot access this resource",
      });
    }
    // The parameter is already proven to identify this provider, so it is
    // normalized to the canonical UUID. Downstream handlers query by primary
    // key and must never receive a provider code.
    if (request.params.providerId !== undefined) {
      request.params.providerId = provider.id;
    }
    request.provider = provider;
    return true;
  }
}
