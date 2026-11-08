import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { providerAdminApiKey } from "../../config/settings.js";
import { constantTimeEqual } from "./provider-auth.service.js";

@Injectable()
export class ProviderAdminGuard implements CanActivate {
  constructor(
    @Inject(ConfigService) private readonly configuration: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    }>();
    const expected = providerAdminApiKey(this.configuration);
    const supplied = request.headers["x-admin-key"];
    if (
      expected.length < 32 ||
      typeof supplied !== "string" ||
      !constantTimeEqual(expected, supplied)
    ) {
      throw new UnauthorizedException({
        code: "ADMIN_AUTHENTICATION_REQUIRED",
        message: "A valid administrative API key is required",
      });
    }
    return true;
  }
}
