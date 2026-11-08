export interface AuthenticatedProvider {
  readonly id: string;
  readonly code: string;
}

export type RequestHeaders = Readonly<
  Record<string, string | string[] | undefined>
>;

/**
 * Turns the credentials carried by a request into the provider they belong
 * to, or throws 401/403. It answers only "who is calling"; whether that
 * provider may touch a given resource is decided by the guard and by the
 * domain, the same way for every adapter.
 *
 * Adapters:
 * - API key (current): `X-Provider-Code` + `X-Provider-Key`, compared in
 *   constant time against `PROVIDER_API_KEYS`.
 * - OIDC (planned): `Authorization: Bearer <JWT>` issued by the IdP through
 *   the client credentials flow, verified against the issuer's JWKS, with the
 *   provider resolved from a claim.
 */
export interface ProviderIdentityPort {
  identify(headers: RequestHeaders): Promise<AuthenticatedProvider>;
}

export interface ProviderAuthenticatedRequest {
  readonly headers: RequestHeaders;
  readonly params: Record<string, string | undefined>;
  provider?: AuthenticatedProvider;
}
