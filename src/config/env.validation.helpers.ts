export type ProviderApiKeyMap = Readonly<Record<string, string>>;

export function requiredString(
  environment: Record<string, unknown>,
  name: string,
): string {
  const value = environment[name];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid environment: ${name} must be a non-empty string`);
  }

  return value;
}

export function validatedPort(
  environment: Record<string, unknown>,
  name: string,
): number {
  const value = requiredString(environment, name);
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Invalid environment: ${name} must be a port from 1 to 65535`,
    );
  }

  return port;
}

export function boundedInteger(
  environment: Record<string, unknown>,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = requiredString(environment, name);
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `Invalid environment: ${name} must be an integer from ${minimum} to ${maximum}`,
    );
  }

  return parsed;
}

export function validateProviderAdminApiKey(
  environment: Record<string, unknown>,
): void {
  const apiKey = environment.PROVIDER_ADMIN_API_KEY;

  if (typeof apiKey !== "string" || (apiKey.length > 0 && apiKey.length < 32)) {
    throw new Error(
      "Invalid environment: PROVIDER_ADMIN_API_KEY must be empty or contain at least 32 characters",
    );
  }
}

export function providerApiKeys(
  environment: Record<string, unknown>,
): ProviderApiKeyMap {
  const value = environment.PROVIDER_API_KEYS;
  if (value === "") {
    return Object.freeze({});
  }
  if (typeof value !== "string") {
    throw invalidProviderApiKeysError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidProviderApiKeysError();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidProviderApiKeysError();
  }

  const keys: Record<string, string> = {};
  for (const [code, secret] of Object.entries(parsed)) {
    if (
      code.trim().length === 0 ||
      code !== code.trim() ||
      code.length > 100 ||
      typeof secret !== "string" ||
      secret.length < 32
    ) {
      throw new Error(
        "Invalid environment: PROVIDER_API_KEYS entries require provider codes up to 100 characters and API keys of at least 32 characters",
      );
    }

    keys[code] = secret;
  }

  return Object.freeze(keys);
}

function invalidProviderApiKeysError(): Error {
  return new Error(
    "Invalid environment: PROVIDER_API_KEYS must be a JSON object of provider codes to API keys",
  );
}
