import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  identifiesProvider,
  ProviderAuthService,
} from "./provider-auth.service.js";
import type { ProviderAuthenticatedRequest } from "./types/index.js";

@Injectable()
export class ProviderApiKeyGuard implements CanActivate {
  constructor(
    @Inject(ProviderAuthService)
    private readonly authentication: ProviderAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ProviderAuthenticatedRequest>();
    const code = singleHeader(request.headers["x-provider-code"]);
    const key = singleHeader(request.headers["x-provider-key"]);
    if (code === undefined || key === undefined) {
      throw new UnauthorizedException({
        code: "PROVIDER_AUTHENTICATION_REQUIRED",
        message: "X-Provider-Code and X-Provider-Key headers are required",
      });
    }

    const provider = await this.authentication.authenticate(code, key);
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

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}
