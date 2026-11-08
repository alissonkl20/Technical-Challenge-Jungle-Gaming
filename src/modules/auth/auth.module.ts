import { Module } from "@nestjs/common";
import { ProvidersModule } from "../providers/providers.module.js";
import { ProviderAdminGuard } from "./provider-admin.guard.js";
import { ProviderApiKeyGuard } from "./provider-auth.guard.js";
import { ProviderAuthService } from "./provider-auth.service.js";

@Module({
  imports: [ProvidersModule],
  providers: [ProviderAuthService, ProviderApiKeyGuard, ProviderAdminGuard],
  exports: [ProviderAuthService, ProviderApiKeyGuard, ProviderAdminGuard],
})
export class AuthModule {}
