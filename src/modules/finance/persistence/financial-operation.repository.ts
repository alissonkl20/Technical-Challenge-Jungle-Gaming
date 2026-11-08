import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import { PostgresRepository } from "./postgres.repository.js";
import type {
  FinancialOperationRepository,
  FinancialOperationRow,
} from "./repositories.js";

export class PostgresFinancialOperationRepository
  extends PostgresRepository
  implements FinancialOperationRepository
{
  constructor(em: PostgreSqlEntityManager) {
    super(em, "financial_operations");
  }

  findById(id: string): Promise<FinancialOperationRow | null> {
    return this.findOne<FinancialOperationRow>(
      `SELECT * FROM ${this.tableName} WHERE id = ?`,
      [id],
    );
  }

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<FinancialOperationRow | null> {
    return this.findOne<FinancialOperationRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = ? AND idempotency_key = ?`,
      [providerId, idempotencyKey],
    );
  }

  findByExternalTransactionId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<FinancialOperationRow | null> {
    return this.findOne<FinancialOperationRow>(
      `SELECT * FROM ${this.tableName} WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
  }

  create(
    operation: Pick<
      FinancialOperationRow,
      | "id"
      | "provider_id"
      | "idempotency_key"
      | "external_transaction_id"
      | "payload_hash"
      | "response_snapshot"
      | "response_http_status"
      | "completed_at"
    >,
  ): Promise<FinancialOperationRow> {
    return this.insert<FinancialOperationRow>(
      [
        "id",
        "provider_id",
        "idempotency_key",
        "external_transaction_id",
        "payload_hash",
        "response_snapshot",
        "response_http_status",
        "completed_at",
      ],
      [
        operation.id,
        operation.provider_id,
        operation.idempotency_key,
        operation.external_transaction_id,
        operation.payload_hash,
        JSON.stringify(operation.response_snapshot),
        operation.response_http_status,
        operation.completed_at,
      ],
    );
  }

  reserve(
    operation: Pick<
      FinancialOperationRow,
      | "id"
      | "provider_id"
      | "idempotency_key"
      | "external_transaction_id"
      | "payload_hash"
      | "response_snapshot"
      | "response_http_status"
      | "completed_at"
      | "correlation_id"
    >,
  ): Promise<FinancialOperationRow | null> {
    const columns = [
      "id",
      "provider_id",
      "idempotency_key",
      "external_transaction_id",
      "payload_hash",
      "response_snapshot",
      "response_http_status",
      "completed_at",
      "correlation_id",
    ] as const;
    const placeholders = columns.map(() => "?").join(", ");
    return this.findOne<FinancialOperationRow>(
      `INSERT INTO ${this.tableName} (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${placeholders})
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        operation.id,
        operation.provider_id,
        operation.idempotency_key,
        operation.external_transaction_id,
        operation.payload_hash,
        JSON.stringify(operation.response_snapshot),
        operation.response_http_status,
        operation.completed_at,
        operation.correlation_id,
      ],
    );
  }

  complete(
    id: string,
    responseSnapshot: unknown,
    responseHttpStatus: number,
    completedAt: Date | null,
  ): Promise<FinancialOperationRow | null> {
    return this.findOne<FinancialOperationRow>(
      `UPDATE ${this.tableName}
       SET response_snapshot = ?, response_http_status = ?, completed_at = ?
       WHERE id = ?
       RETURNING *`,
      [JSON.stringify(responseSnapshot), responseHttpStatus, completedAt, id],
    );
  }
}
