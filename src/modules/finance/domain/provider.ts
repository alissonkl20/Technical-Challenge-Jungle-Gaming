import { DomainError } from "./errors.js";
import { type ProviderId, providerId } from "./types.js";

export const ProviderStatus = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;

export type ProviderStatus =
  (typeof ProviderStatus)[keyof typeof ProviderStatus];

export interface ProviderSnapshot {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DomainError(
      `${field} must contain between 1 and ${maxLength} characters`,
    );
  }
  return normalized;
}

function status(value: string): ProviderStatus {
  if (value !== ProviderStatus.ACTIVE && value !== ProviderStatus.INACTIVE) {
    throw new DomainError(`Invalid provider status: ${value}`);
  }
  return value;
}

export class Provider {
  private constructor(
    readonly id: ProviderId,
    readonly code: string,
    readonly name: string,
    private statusValue: ProviderStatus,
  ) {}

  static register(input: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  }): Provider {
    return new Provider(
      providerId(input.id),
      requiredText(input.code, "code", 100),
      requiredText(input.name, "name", 200),
      ProviderStatus.ACTIVE,
    );
  }

  static rehydrate(snapshot: ProviderSnapshot): Provider {
    return new Provider(
      providerId(snapshot.id),
      requiredText(snapshot.code, "code", 100),
      requiredText(snapshot.name, "name", 200),
      status(snapshot.status),
    );
  }

  get status(): ProviderStatus {
    return this.statusValue;
  }

  setStatus(value: string): void {
    this.statusValue = status(value);
  }

  activate(): void {
    this.setStatus(ProviderStatus.ACTIVE);
  }

  deactivate(): void {
    this.setStatus(ProviderStatus.INACTIVE);
  }

  snapshot(): ProviderSnapshot {
    return {
      id: this.id,
      code: this.code,
      name: this.name,
      status: this.statusValue,
    };
  }
}
