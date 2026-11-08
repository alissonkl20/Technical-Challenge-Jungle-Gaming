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
import { ProviderApiKeyGuard } from "../auth/provider-auth.guard.js";
import type { PlayerSnapshot } from "../finance/domain/index.js";
import { registerPlayerDto, updatePlayerStatusDto } from "./dto/players.dto.js";
import { PlayersService } from "./players.service.js";

@Controller("providers/:providerId/players")
@UseGuards(ProviderApiKeyGuard)
export class PlayersController {
  constructor(
    @Inject(PlayersService) private readonly players: PlayersService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Param("providerId") providerId: string,
    @Body() body: unknown,
  ): Promise<PlayerSnapshot> {
    const input = registerPlayerDto(body);
    const player = await this.players.register(providerId, input);

    return player.snapshot();
  }

  @Get(":externalPlayerId")
  async findByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalPlayerId") externalPlayerId: string,
  ): Promise<PlayerSnapshot> {
    const player = await this.players.findByExternalId(
      providerId,
      externalPlayerId,
    );

    return player.snapshot();
  }

  @Patch(":playerId/status")
  async setStatus(
    @Param("providerId") providerId: string,
    @Param("playerId") playerId: string,
    @Body() body: unknown,
  ): Promise<PlayerSnapshot> {
    const { status } = updatePlayerStatusDto(body);
    const player = await this.players.setStatus(providerId, playerId, status);

    return player.snapshot();
  }
}
