import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { providerFromRow } from "../finance/application/domain-row.mapper.js";
import {
  providerId as asProviderId,
  Provider,
  ProviderAlreadyExistsError,
  ProviderNotFoundError,
} from "../finance/domain/index.js";
import {
  TRANSACTION_MANAGER,
  type TransactionManager,
} from "../finance/persistence/index.js";
import type { RegisterProviderInput } from "./types/index.js";

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(TRANSACTION_MANAGER)
    private readonly transactions: TransactionManager,
  ) {}

  register(input: RegisterProviderInput): Promise<Provider> {
    const candidate = Provider.register({
      id: randomUUID(),
      code: input.code,
      name: input.name,
    });

    return this.transactions.transaction(async ({ providers }) => {
      if (await providers.findByCode(candidate.code)) {
        throw new ProviderAlreadyExistsError(
          `Provider code "${candidate.code}" already exists`,
        );
      }

      const snapshot = candidate.snapshot();
      return providerFromRow(
        await providers.create({
          id: snapshot.id,
          code: snapshot.code,
          name: snapshot.name,
          status: snapshot.status,
        }),
      );
    });
  }

  findById(id: string): Promise<Provider> {
    const validatedId = asProviderId(id);
    return this.transactions.transaction(async ({ providers }) => {
      const row = await providers.findById(validatedId);
      if (!row) {
        throw new ProviderNotFoundError(
          `Provider "${validatedId}" was not found`,
        );
      }
      return providerFromRow(row);
    });
  }

  findByCode(code: string): Promise<Provider> {
    return this.transactions.transaction(async ({ providers }) => {
      const row = await providers.findByCode(code.trim());
      if (!row) {
        throw new ProviderNotFoundError(`Provider "${code}" was not found`);
      }
      return providerFromRow(row);
    });
  }

  setStatus(id: string, requestedStatus: string): Promise<Provider> {
    const validatedId = asProviderId(id);
    return this.transactions.transaction(async ({ providers }) => {
      const existing = await providers.findById(validatedId);
      if (!existing) {
        throw new ProviderNotFoundError(
          `Provider "${validatedId}" was not found`,
        );
      }

      const provider = providerFromRow(existing);
      provider.setStatus(requestedStatus);

      const updated = await providers.updateStatus(
        validatedId,
        provider.status,
      );
      if (!updated) {
        throw new ProviderNotFoundError(
          `Provider "${validatedId}" was not found`,
        );
      }
      return providerFromRow(updated);
    });
  }
}
