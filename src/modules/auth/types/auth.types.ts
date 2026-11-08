export interface AuthenticatedProvider {
  readonly id: string;
  readonly code: string;
}

export interface ProviderAuthenticatedRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly params: Record<string, string | undefined>;
  provider?: AuthenticatedProvider;
}
