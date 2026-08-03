import { Database, SQLiteError } from "bun:sqlite";
import type {
  Deployment,
  DeploymentStatus,
} from "./types.js";

interface DeploymentRow {
  sequence: number;
  id: string;
  service: string;
  version: string;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  readonly deploymentId: string;
  readonly service: string;
  readonly version: string;
}

interface CountRow {
  count: number;
}

interface UserVersionRow {
  userVersion: number;
}

interface NameRow {
  name: string;
}

interface SchemaSqlRow {
  sql: string | null;
}

interface SequenceRow {
  sequence: number | null;
}

export interface RepositoryListQuery {
  readonly service?: string;
  readonly status?: DeploymentStatus;
  readonly limit: number;
  readonly offset: number;
  readonly beforeSequence?: number;
}

export interface RepositoryPage {
  readonly data: readonly Deployment[];
  readonly lastSequence: number | null;
  readonly hasMore: boolean;
}

export function isSqliteBusyError(error: unknown): boolean {
  return error instanceof SQLiteError
    && (error.code === "SQLITE_BUSY"
      || error.code === "SQLITE_BUSY_SNAPSHOT"
      || error.code === "SQLITE_LOCKED");
}

export function isSqliteConstraintError(error: unknown): boolean {
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

const currentSchemaVersion = 2;

export class SqliteDeploymentRepository {
  private readonly database: Database;

  constructor(readonly databasePath = ":memory:", busyTimeoutMs = 5000) {
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
    return this.database.transaction(operation).immediate();
  }

  findIdempotencyKey(key: string): IdempotencyRecord | undefined {
    return this.database.query<IdempotencyRecord, [string]>(`
      SELECT
        deployment_id AS deploymentId,
        service,
        version
      FROM idempotency_keys
      WHERE request_key = ?
    `).get(key) ?? undefined;
  }

  insertIdempotencyKey(key: string, deployment: Deployment): void {
    this.database.query<never, [string, string, string, string]>(`
      INSERT INTO idempotency_keys (request_key, deployment_id, service, version)
      VALUES (?, ?, ?, ?)
    `).run(key, deployment.id, deployment.service, deployment.version);
  }

  findById(id: string): Deployment | undefined {
    const row = this.database.query<DeploymentRow, [string]>(`
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
    return row ? this.toDeployment(row) : undefined;
  }

  hasInFlight(service: string): boolean {
    const row = this.database.query<CountRow, [string]>(`
      SELECT COUNT(*) AS count
      FROM deployments
      WHERE service = ? AND status IN ('queued', 'running')
    `).get(service);
    return (row?.count ?? 0) > 0;
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
    const rows = this.database.query<DeploymentRow, (string | number)[]>(`
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
    `).all(...parameters);

    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    for (const row of pageRows) this.assertSafeSequence(row.sequence);
    return {
      data: pageRows.map((row) => this.toDeployment(row)),
      lastSequence: pageRows.at(-1)?.sequence ?? null,
      hasMore,
    };
  }

  current(service: string): Deployment | undefined {
    const row = this.database.query<DeploymentRow, [string]>(`
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
    return row ? this.toDeployment(row) : undefined;
  }

  countInFlight(): number {
    const row = this.database.query<CountRow, []>(`
      SELECT COUNT(*) AS count
      FROM deployments
      WHERE status IN ('queued', 'running')
    `).get();
    return row?.count ?? 0;
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
      }).immediate();
    }
    this.validateSchema();
  }

  private readSchemaVersion(): number {
    return this.database.query<UserVersionRow, []>(`
      SELECT user_version AS userVersion FROM pragma_user_version
    `).get()?.userVersion ?? 0;
  }

  private validateSchema(): void {
    const deploymentColumns = new Set(this.database.query<NameRow, []>(`
      SELECT name FROM pragma_table_info('deployments')
    `).all().map(({ name }) => name));
    const idempotencyColumns = new Set(this.database.query<NameRow, []>(`
      SELECT name FROM pragma_table_info('idempotency_keys')
    `).all().map(({ name }) => name));
    this.requireColumns("deployments", deploymentColumns, [
      "sequence", "id", "service", "version", "status", "created_at", "updated_at",
    ]);
    this.requireColumns("idempotency_keys", idempotencyColumns, [
      "request_key", "deployment_id", "service", "version",
    ]);

    const indexSql = this.database.query<SchemaSqlRow, []>(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'one_active_deployment_per_service'
    `).get()?.sql?.toLowerCase().replaceAll(/\s+/g, " ");
    if (!indexSql?.includes("where status in ('queued', 'running')")) {
      throw new Error("SQLite schema is missing the active-deployment partial unique index");
    }

    const foreignKey = this.database.query<NameRow, []>(`
      SELECT "table" AS name FROM pragma_foreign_key_list('idempotency_keys')
      WHERE "from" = 'deployment_id'
    `).get()?.name;
    if (foreignKey !== "deployments") {
      throw new Error("SQLite schema is missing the idempotency deployment foreign key");
    }

    const triggerNames = new Set(this.database.query<NameRow, []>(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('immutable_deployment_fields', 'legal_deployment_transition')
    `).all().map(({ name }) => name));
    if (!triggerNames.has("immutable_deployment_fields") || !triggerNames.has("legal_deployment_transition")) {
      throw new Error("SQLite schema is missing deployment integrity triggers");
    }

    const maximum = this.database.query<SequenceRow, []>(`
      SELECT MAX(sequence) AS sequence FROM deployments
    `).get()?.sequence;
    const allocated = this.database.query<SequenceRow, []>(`
      SELECT seq AS sequence FROM sqlite_sequence WHERE name = 'deployments'
    `).get()?.sequence;
    if (maximum !== null && maximum !== undefined) this.assertSafeSequence(maximum);
    if (allocated !== null && allocated !== undefined) this.assertSafeSequence(allocated);
  }

  private requireColumns(table: string, actual: ReadonlySet<string>, required: readonly string[]): void {
    for (const column of required) {
      if (!actual.has(column)) throw new Error(`SQLite schema table '${table}' is missing column '${column}'`);
    }
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
