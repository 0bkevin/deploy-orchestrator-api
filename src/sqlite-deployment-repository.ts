import { Database } from "bun:sqlite";
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

const schema = `
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

export class SqliteDeploymentRepository {
  private readonly database: Database;

  constructor(readonly databasePath = ":memory:") {
    this.database = new Database(databasePath, {
      create: true,
      strict: true,
    });
    this.database.run("PRAGMA foreign_keys = ON");
    this.database.run("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:" && databasePath !== "") {
      this.database.run("PRAGMA journal_mode = WAL");
    }
    this.database.run(schema);
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
    this.database.query<never, [string, string, string, DeploymentStatus, string, string]>(`
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
