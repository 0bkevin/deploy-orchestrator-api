import { Database, SQLiteError } from "bun:sqlite";
import {
  StorageBusyError,
  StorageConstraintError,
  type DeploymentRepository,
  type IdempotencyRecord,
  type RepositoryListQuery,
  type RepositoryPage,
} from "./deployment-repository.js";
import type {
  Deployment,
  DeploymentStatus,
} from "./types.js";
import {
  parseCountRow,
  parseDeploymentRow,
  parseForeignKeyRow,
  parseIdempotencyRecord,
  parseIndexListRow,
  parseNameRow,
  parseSchemaSqlRow,
  parseSequenceRow,
  parseTableInfoRow,
  parseUserVersionRow,
  type DeploymentRow,
  type TableInfoRow,
} from "./sqlite-row-parsers.js";

function isSqliteBusyError(error: unknown): boolean {
  return error instanceof SQLiteError
    && (error.code === "SQLITE_BUSY"
      || error.code === "SQLITE_BUSY_SNAPSHOT"
      || error.code === "SQLITE_LOCKED");
}

function isSqliteConstraintError(error: unknown): boolean {
  const code = error instanceof SQLiteError ? error.code : undefined;
  return typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT");
}

const schemaVersion1 = `
  CREATE TABLE IF NOT EXISTS deployments (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    service TEXT NOT NULL,
    version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('queued', 'running', 'succeeded', 'failed', 'rolled_back')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    request_key TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    service TEXT NOT NULL,
    version TEXT NOT NULL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_deployment_per_service
    ON deployments(service)
    WHERE status IN ('queued', 'running');

  CREATE INDEX IF NOT EXISTS deployments_newest
    ON deployments(sequence DESC);

  CREATE INDEX IF NOT EXISTS deployments_service_status_newest
    ON deployments(service, status, sequence DESC);
`;

const schemaVersion2 = `
  CREATE TRIGGER IF NOT EXISTS immutable_deployment_fields
  BEFORE UPDATE OF sequence, id, service, version, created_at ON deployments
  BEGIN
    SELECT RAISE(ABORT, 'immutable_deployment_fields');
  END;

  CREATE TRIGGER IF NOT EXISTS legal_deployment_transition
  BEFORE UPDATE OF status ON deployments
  WHEN NOT (
       (OLD.status = 'queued' AND NEW.status = 'running')
    OR (OLD.status = 'running' AND NEW.status = 'succeeded')
    OR (OLD.status = 'running' AND NEW.status = 'failed')
    OR (OLD.status = 'succeeded' AND NEW.status = 'rolled_back')
  )
  BEGIN
    SELECT RAISE(ABORT, 'illegal_deployment_transition');
  END;
`;

const activeIndexSql = `
  CREATE UNIQUE INDEX one_active_deployment_per_service
  ON deployments(service)
  WHERE status IN ('queued', 'running')
`;

const immutableTriggerSql = `
  CREATE TRIGGER immutable_deployment_fields
  BEFORE UPDATE OF sequence, id, service, version, created_at ON deployments
  BEGIN
    SELECT RAISE(ABORT, 'immutable_deployment_fields');
  END
`;

const legalTransitionTriggerSql = `
  CREATE TRIGGER legal_deployment_transition
  BEFORE UPDATE OF status ON deployments
  WHEN NOT (
       (OLD.status = 'queued' AND NEW.status = 'running')
    OR (OLD.status = 'running' AND NEW.status = 'succeeded')
    OR (OLD.status = 'running' AND NEW.status = 'failed')
    OR (OLD.status = 'succeeded' AND NEW.status = 'rolled_back')
  )
  BEGIN
    SELECT RAISE(ABORT, 'illegal_deployment_transition');
  END
`;

const schemaVersion3 = `
  DROP INDEX IF EXISTS one_active_deployment_per_service;
  ${activeIndexSql};

  CREATE INDEX IF NOT EXISTS deployments_status_newest
    ON deployments(status, sequence DESC);

  DROP TRIGGER IF EXISTS immutable_deployment_fields;
  ${immutableTriggerSql};
  DROP TRIGGER IF EXISTS legal_deployment_transition;
  ${legalTransitionTriggerSql};

  CREATE TABLE idempotency_keys_version3 (
    request_key TEXT NOT NULL PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    service TEXT NOT NULL,
    version TEXT NOT NULL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
  );
  INSERT INTO idempotency_keys_version3 (request_key, deployment_id, service, version)
    SELECT request_key, deployment_id, service, version FROM idempotency_keys;
  DROP TABLE idempotency_keys;
  ALTER TABLE idempotency_keys_version3 RENAME TO idempotency_keys;
`;

const currentSchemaVersion = 3;

export class SqliteDeploymentRepository implements DeploymentRepository {
  private readonly database: Database;

  constructor(readonly databasePath = ":memory:", busyTimeoutMs = 1000) {
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
      throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
    }
    this.database = new Database(databasePath, {
      create: true,
      strict: true,
    });
    try {
      this.database.run("PRAGMA foreign_keys = ON");
      this.database.run(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      if (databasePath !== ":memory:" && databasePath !== "") {
        this.database.run("PRAGMA journal_mode = WAL");
      }
      this.migrate();
    } catch (error) {
      this.database.close(false);
      throw error;
    }
  }

  close(): void {
    this.database.close(false);
  }

  immediate<T>(operation: () => T): T {
    try {
      return this.database.transaction(operation).immediate();
    } catch (error) {
      if (isSqliteBusyError(error)) throw new StorageBusyError(error);
      if (isSqliteConstraintError(error)) throw new StorageConstraintError(error);
      throw error;
    }
  }

  findIdempotencyKey(key: string): IdempotencyRecord | undefined {
    const row = this.database.query<unknown, [string]>(`
      SELECT
        deployment_id AS deploymentId,
        service,
        version
      FROM idempotency_keys
      WHERE request_key = ?
    `).get(key);
    return row === null ? undefined : parseIdempotencyRecord(row);
  }

  insertIdempotencyKey(key: string, deployment: Deployment): void {
    this.database.query<never, [string, string, string, string]>(`
      INSERT INTO idempotency_keys (request_key, deployment_id, service, version)
      VALUES (?, ?, ?, ?)
    `).run(key, deployment.id, deployment.service, deployment.version);
  }

  findById(id: string): Deployment | undefined {
    const row = this.database.query<unknown, [string]>(`
      SELECT
        sequence,
        id,
        service,
        version,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM deployments
      WHERE id = ?
    `).get(id);
    return row === null ? undefined : this.toDeployment(parseDeploymentRow(row));
  }

  hasInFlight(service: string): boolean {
    const row = this.database.query<unknown, [string]>(`
      SELECT COUNT(*) AS count
      FROM deployments
      WHERE service = ? AND status IN ('queued', 'running')
    `).get(service);
    return row !== null && parseCountRow(row) > 0;
  }

  insertDeployment(deployment: Deployment): void {
    const result = this.database.query<never, [string, string, string, DeploymentStatus, string, string]>(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      deployment.id,
      deployment.service,
      deployment.version,
      deployment.status,
      deployment.createdAt,
      deployment.updatedAt,
    );
    this.assertSafeSequence(result.lastInsertRowid);
  }

  updateStatus(
    id: string,
    expectedStatus: DeploymentStatus,
    targetStatus: DeploymentStatus,
    updatedAt: string,
  ): boolean {
    const result = this.database.query<never, [DeploymentStatus, string, string, DeploymentStatus]>(`
      UPDATE deployments
      SET status = ?, updated_at = ?
      WHERE id = ? AND status = ?
    `).run(targetStatus, updatedAt, id, expectedStatus);
    return result.changes === 1;
  }

  list(query: RepositoryListQuery): RepositoryPage {
    const predicates: string[] = [];
    const parameters: (string | number)[] = [];

    if (query.service !== undefined) {
      predicates.push("service = ?");
      parameters.push(query.service);
    }
    if (query.status !== undefined) {
      predicates.push("status = ?");
      parameters.push(query.status);
    }
    if (query.beforeSequence !== undefined) {
      predicates.push("sequence < ?");
      parameters.push(query.beforeSequence);
    }

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    parameters.push(query.limit + 1, query.offset);
    const rows = this.database.query<unknown, (string | number)[]>(`
      SELECT
        sequence,
        id,
        service,
        version,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM deployments
      ${where}
      ORDER BY sequence DESC
      LIMIT ? OFFSET ?
    `).all(...parameters).map(parseDeploymentRow);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: pageRows.map((row) => this.toDeployment(row)),
      lastSequence: pageRows.at(-1)?.sequence ?? null,
      hasMore,
    };
  }

  current(service: string): Deployment | undefined {
    const row = this.database.query<unknown, [string]>(`
      SELECT
        sequence,
        id,
        service,
        version,
        status,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM deployments
      WHERE service = ? AND status = 'succeeded'
      ORDER BY sequence DESC
      LIMIT 1
    `).get(service);
    return row === null ? undefined : this.toDeployment(parseDeploymentRow(row));
  }

  countInFlight(): number {
    const row = this.database.query<unknown, []>(`
      SELECT COUNT(*) AS count
      FROM deployments
      WHERE status IN ('queued', 'running')
    `).get();
    return row === null ? 0 : parseCountRow(row);
  }

  private migrate(): void {
    const initialVersion = this.readSchemaVersion();
    if (initialVersion > currentSchemaVersion) {
      throw new Error(`Unsupported SQLite schema version ${String(initialVersion)}`);
    }
    if (initialVersion < currentSchemaVersion) {
      this.database.transaction(() => {
        const lockedVersion = this.readSchemaVersion();
        if (lockedVersion > currentSchemaVersion) {
          throw new Error(`Unsupported SQLite schema version ${String(lockedVersion)}`);
        }
        if (lockedVersion === 0) {
          this.database.run(schemaVersion1);
          this.database.run("PRAGMA user_version = 1");
        }
        if (lockedVersion < 2) {
          this.database.run(schemaVersion2);
          this.database.run("PRAGMA user_version = 2");
        }
        if (lockedVersion < 3) {
          const nullKeyRow = this.database.query<unknown, []>(`
            SELECT COUNT(*) AS count FROM idempotency_keys WHERE request_key IS NULL
          `).get();
          const nullKeys = nullKeyRow === null ? 0 : parseCountRow(nullKeyRow);
          if (nullKeys > 0) {
            throw new Error("SQLite schema contains null idempotency keys and cannot migrate safely");
          }
          this.database.run(schemaVersion3);
          this.database.run("PRAGMA user_version = 3");
        }
      }).immediate();
    }
    this.validateSchema();
  }

  private readSchemaVersion(): number {
    const row = this.database.query<unknown, []>(`
      SELECT user_version AS userVersion FROM pragma_user_version
    `).get();
    return row === null ? 0 : parseUserVersionRow(row);
  }

  private validateSchema(): void {
    const deploymentColumns = this.database.query<unknown, []>(`
      SELECT name, "notnull" AS "notNull", pk AS "primaryKey"
      FROM pragma_table_info('deployments')
    `).all().map(parseTableInfoRow);
    const idempotencyColumns = this.database.query<unknown, []>(`
      SELECT name, "notnull" AS "notNull", pk AS "primaryKey"
      FROM pragma_table_info('idempotency_keys')
    `).all().map(parseTableInfoRow);
    this.requireColumn("deployments", deploymentColumns, "sequence", { primaryKey: true });
    for (const column of ["id", "service", "version", "status", "created_at", "updated_at"]) {
      this.requireColumn("deployments", deploymentColumns, column, { notNull: true });
    }
    this.requireColumn("idempotency_keys", idempotencyColumns, "request_key", {
      notNull: true,
      primaryKey: true,
    });
    for (const column of ["deployment_id", "service", "version"]) {
      this.requireColumn("idempotency_keys", idempotencyColumns, column, { notNull: true });
    }

    const deploymentTableSql = this.readSchemaSql("table", "deployments");
    const normalizedTableSql = this.normalizeSql(deploymentTableSql);
    const statusCheck = "status text not null check ( status in ('queued', 'running', 'succeeded', 'failed', 'rolled_back') )";
    if (!normalizedTableSql.includes(statusCheck)) {
      throw new Error("SQLite deployments table is missing the canonical status constraint");
    }

    const indexes = this.database.query<unknown, []>(`
      SELECT name, "unique" AS "uniqueIndex", partial
      FROM pragma_index_list('deployments')
    `).all().map(parseIndexListRow);
    const idIsUnique = indexes.some((index) => index.uniqueIndex === 1
      && this.indexColumns(index.name).join(",") === "id");
    if (!idIsUnique) throw new Error("SQLite deployments table is missing the unique ID constraint");

    const activeIndex = indexes.find(({ name }) => name === "one_active_deployment_per_service");
    if (activeIndex?.uniqueIndex !== 1
      || activeIndex.partial !== 1
      || this.indexColumns(activeIndex.name).join(",") !== "service"
      || this.normalizeSql(this.readSchemaSql("index", activeIndex.name)) !== this.normalizeSql(activeIndexSql)) {
      throw new Error("SQLite schema has an invalid active-deployment partial unique index");
    }
    const statusIndex = indexes.find(({ name }) => name === "deployments_status_newest");
    if (!statusIndex || this.indexColumns(statusIndex.name).join(",") !== "status,sequence") {
      throw new Error("SQLite schema is missing the status-listing index");
    }

    const foreignKeyRow = this.database.query<unknown, []>(`
      SELECT
        "table" AS "referencedTable",
        "from" AS "sourceColumn",
        "to" AS "targetColumn",
        on_delete AS "onDelete"
      FROM pragma_foreign_key_list('idempotency_keys')
      WHERE "from" = 'deployment_id'
    `).get();
    const foreignKey = foreignKeyRow === null ? undefined : parseForeignKeyRow(foreignKeyRow);
    if (foreignKey?.referencedTable !== "deployments"
      || foreignKey.sourceColumn !== "deployment_id"
      || foreignKey.targetColumn !== "id"
      || foreignKey.onDelete.toUpperCase() !== "CASCADE") {
      throw new Error("SQLite schema has an invalid idempotency deployment foreign key");
    }

    if (this.normalizeSql(this.readSchemaSql("trigger", "immutable_deployment_fields"))
      !== this.normalizeSql(immutableTriggerSql)) {
      throw new Error("SQLite schema has an invalid immutable-fields trigger");
    }
    if (this.normalizeSql(this.readSchemaSql("trigger", "legal_deployment_transition"))
      !== this.normalizeSql(legalTransitionTriggerSql)) {
      throw new Error("SQLite schema has an invalid legal-transition trigger");
    }

    const maximumRow = this.database.query<unknown, []>(`
      SELECT MAX(sequence) AS sequence FROM deployments
    `).get();
    const allocatedRow = this.database.query<unknown, []>(`
      SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'deployments'
    `).get();
    const maximum = maximumRow === null ? null : parseSequenceRow(maximumRow);
    const allocated = allocatedRow === null ? null : parseSequenceRow(allocatedRow);
    if (maximum !== null) this.assertSafeSequence(maximum);
    if (allocated !== null) this.assertSafeSequence(allocated);
  }

  private requireColumn(
    table: string,
    columns: readonly TableInfoRow[],
    name: string,
    requirements: { readonly notNull?: boolean; readonly primaryKey?: boolean },
  ): void {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) throw new Error(`SQLite schema table '${table}' is missing column '${name}'`);
    if (requirements.notNull && column.notNull !== 1) {
      throw new Error(`SQLite schema column '${table}.${name}' must be NOT NULL`);
    }
    if (requirements.primaryKey && column.primaryKey < 1) {
      throw new Error(`SQLite schema column '${table}.${name}' must be a primary key`);
    }
  }

  private indexColumns(indexName: string): string[] {
    return this.database.query<unknown, [string]>(`
      SELECT name FROM pragma_index_info(?) ORDER BY seqno
    `).all(indexName).map(parseNameRow);
  }

  private readSchemaSql(type: "table" | "index" | "trigger", name: string): string {
    const row = this.database.query<unknown, [string, string]>(`
      SELECT sql FROM sqlite_master WHERE type = ? AND name = ?
    `).get(type, name);
    const sql = row === null ? null : parseSchemaSqlRow(row);
    if (!sql) throw new Error(`SQLite schema is missing ${type} '${name}'`);
    return sql;
  }

  private normalizeSql(sql: string): string {
    return sql.trim().replace(/;$/, "").toLowerCase().replaceAll(/\s+/g, " ");
  }

  private assertSafeSequence(sequence: number | bigint): void {
    const safe = typeof sequence === "bigint"
      ? sequence <= BigInt(Number.MAX_SAFE_INTEGER)
      : Number.isSafeInteger(sequence);
    if (!safe) throw new Error("SQLite deployment sequence exceeds JavaScript's safe integer range");
  }

  private toDeployment(row: DeploymentRow): Deployment {
    return {
      id: row.id,
      service: row.service,
      version: row.version,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
