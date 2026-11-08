/**
 * Injection token for the `ProviderIdentityPort`.
 *
 * This is the authentication extension point: `AuthModule` binds it to the
 * API key adapter today. Moving to an external Identity Provider (Keycloak,
 * Zitadel) means binding it to an OIDC adapter instead; guards, controllers
 * and the financial use case do not change. See ARCHITECTURE.md, section 8.
 */
export const PROVIDER_IDENTITY = Symbol("PROVIDER_IDENTITY");
