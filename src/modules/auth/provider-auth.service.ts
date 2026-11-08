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
import type { AuthenticatedProvider } from "./types/index.js";

@Injectable()
export class ProviderAuthService {
  private readonly apiKeys: ProviderApiKeyMap;

  constructor(
    @Inject(ConfigService) configuration: ConfigService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {
    this.apiKeys = configuredProviderApiKeys(configuration);
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
