import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ProviderAdminGuard } from "../auth/provider-admin.guard.js";
import { ProviderApiKeyGuard } from "../auth/provider-auth.guard.js";
import type { ProviderSnapshot } from "../finance/domain/index.js";
import {
  registerProviderDto,
  updateProviderStatusDto,
} from "./dto/providers.dto.js";
import { ProvidersService } from "./providers.service.js";

@Controller("providers")
export class ProvidersController {
  constructor(
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ProviderAdminGuard)
  async register(@Body() body: unknown): Promise<ProviderSnapshot> {
    const input = registerProviderDto(body);
    const provider = await this.providers.register(input);

    return provider.snapshot();
  }

  @Get(":providerId")
  @UseGuards(ProviderApiKeyGuard)
  findById(@Param("providerId") providerId: string): Promise<ProviderSnapshot> {
    return this.providers
      .findById(providerId)
      .then((provider) => provider.snapshot());
  }

  @Get("by-code/:code")
  @UseGuards(ProviderApiKeyGuard)
  findByCode(@Param("code") code: string): Promise<ProviderSnapshot> {
    return this.providers
      .findByCode(code)
      .then((provider) => provider.snapshot());
  }

  @Patch(":providerId/status")
  @UseGuards(ProviderAdminGuard)
  async setStatus(
    @Param("providerId") providerId: string,
    @Body() body: unknown,
  ): Promise<ProviderSnapshot> {
    const { status } = updateProviderStatusDto(body);
    const provider = await this.providers.setStatus(providerId, status);

    return provider.snapshot();
  }
}
