import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { PROVIDER_IDENTITY } from "./auth.tokens.js";
import { ProviderAdminGuard } from "./provider-admin.guard.js";
import { ProviderApiKeyGuard } from "./provider-auth.guard.js";
import { ProviderAuthService } from "./provider-auth.service.js";

@Module({
  imports: [ProvidersModule],
  providers: [
    ProviderAuthService,
    // Extension point: bind an OIDC adapter here to move to an external IdP.
    { provide: PROVIDER_IDENTITY, useExisting: ProviderAuthService },
    ProviderApiKeyGuard,
    ProviderAdminGuard,
  ],
  exports: [
    ProviderAuthService,
    PROVIDER_IDENTITY,
    ProviderApiKeyGuard,
    ProviderAdminGuard,
  ],
})
export class AuthModule {}
