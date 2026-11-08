export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {}

export class CurrencyMismatchError extends DomainError {}

export class InsufficientFundsError extends DomainError {}

export class InvalidWalletError extends DomainError {}

export class InvalidLedgerEntryError extends DomainError {}

export class ProviderNotFoundError extends DomainError {}

export class PlayerNotFoundError extends DomainError {}

export class WalletNotFoundError extends DomainError {}
export class FinancialOperationNotFoundError extends DomainError {}
export class WagerTransactionNotFoundError extends DomainError {}

export class ProviderAlreadyExistsError extends DomainError {}

export class DuplicatePlayerError extends DomainError {}

export class DuplicateWalletError extends DomainError {}

export class InactiveProviderError extends DomainError {}

export class InactivePlayerError extends DomainError {}

export class InvalidWagerTransactionError extends DomainError {}

export class InvalidPayloadError extends DomainError {}

export class InvalidStateTransitionError extends DomainError {}

export class IdempotencyReplayError extends DomainError {
  constructor(
    readonly idempotencyKey: string,
    readonly existingFingerprint: string,
  ) {
    super(
      `Idempotency key "${idempotencyKey}" already exists for this payload`,
    );
  }
}

export class IdempotencyConflictError extends DomainError {
  constructor(
    readonly idempotencyKey: string,
    readonly existingFingerprint: string,
    readonly incomingFingerprint: string,
  ) {
    super(
      `Idempotency key "${idempotencyKey}" was used with a different payload`,
    );
  }
}
