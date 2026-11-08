import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { EntityManager as PostgreSqlEntityManager } from "@mikro-orm/postgresql";
import {
  LOCKING_READ_PATTERN,
  observeLockWait,
} from "../../../shared/observability/lock-wait.js";

type PersistedRow = object;

export class PostgresRepository {
  protected readonly tableName: string;

  constructor(
    protected readonly em: PostgreSqlEntityManager,
    tableName: string,
  ) {
    const schema = em.config.get("schema") ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
      throw new Error("PostgreSQL schema must be a lowercase SQL identifier");
    }

    this.tableName = `"${schema}"."${tableName}"`;
  }

  protected async findOne<Row extends PersistedRow>(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<Row | null> {
    if (!LOCKING_READ_PATTERN.test(sql)) {
      const rows = await this.em.execute<Row[]>(sql, [...parameters]);
      return rows[0] ?? null;
    }
    const startedAt = performance.now();
    try {
      const rows = await this.em.execute<Row[]>(sql, [...parameters]);
      return rows[0] ?? null;
    } finally {
      observeLockWait(performance.now() - startedAt);
    }
  }

  protected async insert<Row extends PersistedRow>(
    columns: readonly string[],
    values: readonly unknown[],
    returning = "*",
  ): Promise<Row> {
    const columnList = columns.map((column) => `"${column}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const rows = await this.em.execute<Row[]>(
      `INSERT INTO ${this.tableName} (${columnList}) VALUES (${placeholders}) RETURNING ${returning}`,
      [...values],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`Insert into ${this.tableName} returned no row`);
    }
    return row;
  }

  protected async insertWithUniqueTranslation<Row extends PersistedRow>(
    columns: readonly string[],
    values: readonly unknown[],
    constraint: string,
    translate: () => Error,
  ): Promise<Row> {
    try {
      return await this.insert<Row>(columns, values);
    } catch (error) {
      if (
        error instanceof UniqueConstraintViolationException &&
        "constraint" in error &&
        error.constraint === constraint
      ) {
        throw translate();
      }
      throw error;
    }
  }
}
