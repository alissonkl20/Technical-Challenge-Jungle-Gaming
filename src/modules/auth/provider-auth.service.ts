import { createHash, timingSafeEqual } from "node:crypto";
import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ProviderApiKeyMap } from "../../config/env.validation.js";
import { configuredProviderApiKeys } from "../../config/settings.js";
import {
  type Provider,
  ProviderNotFoundError,
  ProviderStatus,
} from "../finance/domain/index.js";
import { ProvidersService } from "../providers/providers.service.js";
import type {
  AuthenticatedProvider,
  ProviderIdentityPort,
  RequestHeaders,
} from "./types/index.js";

/**
 * API key adapter of `ProviderIdentityPort`: one shared secret per provider,
 * configured by the operator in `PROVIDER_API_KEYS`. There is no user table
 * and no password hashing; replacing this adapter with an OIDC one is the
 * documented path to an external Identity Provider.
 */
@Injectable()
export class ProviderAuthService implements ProviderIdentityPort {
  private readonly apiKeys: ProviderApiKeyMap;

  constructor(
    @Inject(ConfigService) configuration: ConfigService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {
    this.apiKeys = configuredProviderApiKeys(configuration);
  }

  identify(headers: RequestHeaders): Promise<AuthenticatedProvider> {
    const code = singleHeader(headers["x-provider-code"]);
    const key = singleHeader(headers["x-provider-key"]);
    if (code === undefined || key === undefined) {
      throw new UnauthorizedException({
        code: "PROVIDER_AUTHENTICATION_REQUIRED",
        message: "X-Provider-Code and X-Provider-Key headers are required",
      });
    }
    return this.authenticate(code, key);
  }

  async authenticate(
    code: string,
    suppliedKey: string,
  ): Promise<AuthenticatedProvider> {
    const configuredKey = this.apiKeys[code];
    if (
      configuredKey === undefined ||
      !constantTimeEqual(configuredKey, suppliedKey)
    ) {
      throw new UnauthorizedException({
        code: "PROVIDER_AUTHENTICATION_FAILED",
        message: "Invalid provider credentials",
      });
    }

    let provider: Provider;
    try {
      provider = await this.providers.findByCode(code);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        throw new UnauthorizedException({
          code: "PROVIDER_AUTHENTICATION_FAILED",
          message: "Invalid provider credentials",
        });
      }
      throw error;
    }

    if (provider.status !== ProviderStatus.ACTIVE) {
      throw new ForbiddenException({
        code: "PROVIDER_INACTIVE",
        message: "Provider is not authorized",
      });
    }

    return { id: provider.id, code: provider.code };
  }
}

/**
 * Providers address themselves either by the registered UUID or by the code
 * they authenticate with, so a published identifier such as `provider-a`
 * works wherever an identifier is accepted.
 */
export function identifiesProvider(
  value: string,
  provider: AuthenticatedProvider,
): boolean {
  return value === provider.id || value === provider.code;
}

export function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function singleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  return value;
}
