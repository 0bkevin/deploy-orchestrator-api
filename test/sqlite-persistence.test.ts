import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DeploymentService } from "../src/deployment-service.js";
import { ApiError } from "../src/errors.js";
import { createApp } from "../src/server.js";
import { SqliteDeploymentRepository } from "../src/sqlite-deployment-repository.js";
import type { Deployment } from "../src/types.js";
import { parseDeployment, parseDeploymentPage, parseError, parseResponse } from "./response-parser.js";

const temporaryDatabases = new Set<string>();

function temporaryDatabase(): string {
  const path = `/tmp/deploy-orchestrator-${crypto.randomUUID()}.sqlite`;
  temporaryDatabases.add(path);
  return path;
}

async function deleteDatabase(path: string): Promise<void> {
  await Promise.all([
    Bun.file(path).delete(),
    Bun.file(`${path}-shm`).delete(),
    Bun.file(`${path}-wal`).delete(),
  ].map(async (operation) => {
    try {
      await operation;
    } catch {
      // A sidecar may not exist when WAL was already checkpointed on close.
    }
  }));
}

afterEach(async () => {
  await Promise.all([...temporaryDatabases].map(deleteDatabase));
  temporaryDatabases.clear();
});

function serviceFor(path: string): DeploymentService {
  return new DeploymentService(new SqliteDeploymentRepository(path));
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface WorkerResult {
  readonly exitCode: number;
  readonly output: string;
  readonly error: string;
}

async function runWorkers(
  fixtureName: string,
  argumentSets: readonly (readonly string[])[],
): Promise<WorkerResult[]> {
  const fixture = decodeURIComponent(new URL(`./fixtures/${fixtureName}`, import.meta.url).pathname);
  const workers = argumentSets.map((arguments_) => Bun.spawn([
    Bun.argv[0] ?? "bun",
    fixture,
    ...arguments_,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  }));
  return Promise.all(workers.map(async (worker) => {
    const outputPromise = new Response(worker.stdout).text();
    const errorPromise = new Response(worker.stderr).text();
    const exitCode = await worker.exited;
    return {
      exitCode,
      output: (await outputPromise).trim(),
      error: await errorPromise,
    };
  }));
}

describe("SQLite persistence and constraints", () => {
  test("persists deployments and idempotency keys across service restarts", () => {
    const path = temporaryDatabase();
    const firstService = serviceFor(path);
    const created = firstService.create({ service: "orders", version: "1.0.0" }, "orders-1");
    firstService.transition(created.id, "running");
    firstService.close();

    const restartedService = serviceFor(path);
    const replay = restartedService.create({ service: "orders", version: "1.0.0" }, "orders-1");
    expect(replay).toMatchObject({ id: created.id, status: "running" });
    expect(restartedService.list().data).toHaveLength(1);
    expect(restartedService.health().inFlight).toBe(1);
    expect(() => restartedService.create(
      { service: "payments", version: "9.0.0" },
      "orders-1",
    )).toThrow(/different payload/);
    restartedService.close();
  });

  test("rejects a deployment row with an unexpected SQLite value type", () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    const deployment = service.create({ service: "corrupt-deployment", version: "1" });
    service.close();

    const database = new Database(path, { strict: true });
    database.query<never, [string]>(`
      UPDATE deployments SET updated_at = X'00' WHERE id = ?
    `).run(deployment.id);
    database.close(false);

    const repository = new SqliteDeploymentRepository(path);
    expect(() => repository.findById(deployment.id)).toThrow(/deployment row updatedAt/);
    repository.close();
  });

  test("rejects an idempotency row with an unexpected SQLite value type", () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    service.create({ service: "corrupt-idempotency", version: "1" }, "corrupt-key");
    service.close();

    const database = new Database(path, { strict: true });
    database.query<never, [string]>(`
      UPDATE idempotency_keys SET version = X'00' WHERE request_key = ?
    `).run("corrupt-key");
    database.close(false);

    const repository = new SqliteDeploymentRepository(path);
    expect(() => repository.findIdempotencyKey("corrupt-key")).toThrow(/idempotency row version/);
    repository.close();
  });

  test("does not reserve an idempotency key when creation conflicts and rolls back", () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    const blocker = service.create({ service: "orders", version: "1" });
    expect(() => service.create(
      { service: "orders", version: "2" },
      "retry-after-conflict",
    )).toThrow(/already has/);
    service.transition(blocker.id, "running");
    service.transition(blocker.id, "failed");
    const retried = service.create(
      { service: "orders", version: "2" },
      "retry-after-conflict",
    );
    expect(retried).toMatchObject({ service: "orders", version: "2", status: "queued" });
    service.close();
  });

  test("restores current-deployment history after a database restart", () => {
    const path = temporaryDatabase();
    const firstService = serviceFor(path);
    const first = firstService.create({ service: "web", version: "1.0.0" });
    firstService.transition(first.id, "running");
    firstService.transition(first.id, "succeeded");
    const latest = firstService.create({ service: "web", version: "2.0.0" });
    firstService.transition(latest.id, "running");
    firstService.transition(latest.id, "succeeded");
    firstService.transition(latest.id, "rolled_back");
    firstService.close();

    const restartedService = serviceFor(path);
    expect(restartedService.current("web")).toMatchObject({ id: first.id, version: "1.0.0" });
    expect(restartedService.list().data.map(({ id }) => id)).toEqual([latest.id, first.id]);
    restartedService.close();
  });

  test("keeps cursor pagination stable across restart and insertion", () => {
    const path = temporaryDatabase();
    const firstService = serviceFor(path);
    const oldest = firstService.create({ service: "one", version: "1" });
    firstService.create({ service: "two", version: "2" });
    firstService.create({ service: "three", version: "3" });
    const firstPage = firstService.list({ limit: 2 });
    expect(firstPage.nextCursor).toBeTruthy();
    firstService.close();

    const restartedService = serviceFor(path);
    restartedService.create({ service: "four", version: "4" });
    const secondPage = firstPage.nextCursor === null
      ? restartedService.list({ limit: 2 })
      : restartedService.list({ limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.data.map(({ id }) => id)).toEqual([oldest.id]);
    restartedService.close();
  });

  test("rolls back every write when a SQLite transaction throws", () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    const deployment: Deployment = {
      id: crypto.randomUUID(),
      service: "atomic",
      version: "1",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(() => repository.immediate(() => {
      repository.insertDeployment(deployment);
      repository.insertIdempotencyKey("atomic-1", deployment);
      throw new Error("force rollback");
    })).toThrow(/force rollback/);
    expect(repository.findById(deployment.id)).toBeUndefined();
    expect(repository.findIdempotencyKey("atomic-1")).toBeUndefined();
    repository.close();
  });

  test("applies ordered schema migrations and rejects unsupported future schemas", () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();

    const oldDatabase = new Database(path, { strict: true });
    oldDatabase.run("DROP TRIGGER immutable_deployment_fields");
    oldDatabase.run("DROP TRIGGER legal_deployment_transition");
    oldDatabase.run("PRAGMA user_version = 1");
    oldDatabase.close(false);

    const migratedRepository = new SqliteDeploymentRepository(path);
    migratedRepository.close();
    const database = new Database(path, { strict: true });
    const version = database.query<unknown, []>(`
      SELECT user_version AS userVersion FROM pragma_user_version
    `).get();
    const triggerCount = database.query<unknown, []>(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name IN ('immutable_deployment_fields', 'legal_deployment_transition')
    `).get();
    expect(version).toEqual({ userVersion: 3 });
    expect(triggerCount).toEqual({ count: 2 });
    database.run("PRAGMA user_version = 99");
    database.close(false);

    expect(() => new SqliteDeploymentRepository(path)).toThrow(/Unsupported SQLite schema version 99/);
  });

  test("rejects a malformed database that falsely claims the current schema version", () => {
    const path = temporaryDatabase();
    const database = new Database(path, { create: true, strict: true });
    database.run("CREATE TABLE deployments (id TEXT)");
    database.run("PRAGMA user_version = 3");
    database.close(false);

    expect(() => new SqliteDeploymentRepository(path)).toThrow(/missing column 'sequence'/);
  });

  test("rejects counterfeit current-version indexes and triggers", () => {
    const indexPath = temporaryDatabase();
    const indexRepository = new SqliteDeploymentRepository(indexPath);
    indexRepository.close();
    const indexDatabase = new Database(indexPath, { strict: true });
    indexDatabase.run("DROP INDEX one_active_deployment_per_service");
    indexDatabase.run(`
      CREATE INDEX one_active_deployment_per_service ON deployments(sequence)
      WHERE status IN ('queued', 'running')
    `);
    indexDatabase.close(false);
    expect(() => new SqliteDeploymentRepository(indexPath)).toThrow(/invalid active-deployment/);

    const triggerPath = temporaryDatabase();
    const triggerRepository = new SqliteDeploymentRepository(triggerPath);
    triggerRepository.close();
    const triggerDatabase = new Database(triggerPath, { strict: true });
    triggerDatabase.run("DROP TRIGGER legal_deployment_transition");
    triggerDatabase.run(`
      CREATE TRIGGER legal_deployment_transition AFTER INSERT ON deployments
      BEGIN SELECT 1; END
    `);
    triggerDatabase.close(false);
    expect(() => new SqliteDeploymentRepository(triggerPath)).toThrow(/invalid legal-transition trigger/);
  });

  test("repairs version-2 counterfeit integrity objects during migration", () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();
    const database = new Database(path, { strict: true });
    database.run("DROP INDEX one_active_deployment_per_service");
    database.run(`
      CREATE INDEX one_active_deployment_per_service ON deployments(sequence)
      WHERE status IN ('queued', 'running')
    `);
    database.run("DROP TRIGGER legal_deployment_transition");
    database.run(`
      CREATE TRIGGER legal_deployment_transition AFTER INSERT ON deployments
      BEGIN SELECT 1; END
    `);
    database.run("PRAGMA user_version = 2");
    database.close(false);

    const repaired = new SqliteDeploymentRepository(path);
    const deployment = serviceFor(path);
    const queued = deployment.create({ service: "repaired", version: "1" });
    expect(() => repaired.updateStatus(queued.id, "queued", "succeeded", new Date().toISOString()))
      .toThrow(/illegal_deployment_transition/);
    deployment.close();
    repaired.close();
  });

  test("rejects persisted creation sequences outside JavaScript's safe integer range", () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    const deployment: Deployment = {
      id: crypto.randomUUID(),
      service: "sequence-guard",
      version: "1",
      status: "succeeded",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    repository.insertDeployment(deployment);
    repository.close();
    const database = new Database(path, { strict: true });
    database.run("UPDATE sqlite_sequence SET seq = 9007199254740992 WHERE name = 'deployments'");
    database.close(false);

    expect(() => new SqliteDeploymentRepository(path)).toThrow(/safe integer range/);
  });

  test("enforces status, active-service and foreign-key constraints in SQLite", () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();
    const database = new Database(path, { strict: true });
    database.run("PRAGMA foreign_keys = ON");
    const now = new Date().toISOString();

    expect(() => database.query(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), "bad", "1", "unknown", now, now)).toThrow();

    const activeId = crypto.randomUUID();
    database.query(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(activeId, "orders", "1", "queued", now, now);
    expect(() => database.query(`
      UPDATE deployments SET status = 'succeeded' WHERE id = ?
    `).run(activeId)).toThrow(/illegal_deployment_transition/);
    expect(() => database.query(`
      UPDATE deployments SET service = 'renamed' WHERE id = ?
    `).run(activeId)).toThrow(/immutable_deployment_fields/);
    expect(() => database.query(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), "orders", "2", "running", now, now)).toThrow();

    expect(() => database.query(`
      INSERT INTO idempotency_keys (request_key, deployment_id, service, version)
      VALUES (?, ?, ?, ?)
    `).run("missing", "does-not-exist", "orders", "1")).toThrow();
    expect(() => database.query(`
      INSERT INTO idempotency_keys (request_key, deployment_id, service, version)
      VALUES (?, ?, ?, ?)
    `).run(null, activeId, "orders", "1")).toThrow();
    database.close(false);
  });

  test("binds SQL-like values literally and passes SQLite integrity checks", () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    const sqlLikeService = "orders'; DROP TABLE deployments; --";
    const sqlLikeKey = "key'); DELETE FROM idempotency_keys; --";
    const created = service.create({ service: sqlLikeService, version: "v'1" }, sqlLikeKey);
    expect(service.list({ service: sqlLikeService }).data.map(({ id }) => id)).toEqual([created.id]);
    expect(service.create({ service: sqlLikeService, version: "v'1" }, sqlLikeKey).id).toBe(created.id);
    service.close();

    const database = new Database(path, { strict: true });
    const integrity = database.query<unknown, []>(`
      SELECT integrity_check AS result FROM pragma_integrity_check
    `).get();
    const foreignKeyViolations = database.query<unknown, []>("PRAGMA foreign_key_check").all();
    const journalMode = database.query<unknown, []>(`
      SELECT journal_mode AS mode FROM pragma_journal_mode
    `).get();
    const statusQueryPlan = database.query<unknown, [string]>(`
      EXPLAIN QUERY PLAN
      SELECT * FROM deployments WHERE status = ? ORDER BY sequence DESC
    `).all("queued");
    expect(integrity).toEqual({ result: "ok" });
    expect(foreignKeyViolations).toHaveLength(0);
    expect(journalMode).toEqual({ mode: "wal" });
    expect(JSON.stringify(statusQueryPlan)).toContain("deployments_status_newest");
    database.close(false);
  });

  test("translates SQLite write contention into a retryable 503 instead of a 500", async () => {
    const path = temporaryDatabase();
    const bootstrap = new SqliteDeploymentRepository(path);
    bootstrap.close();
    const locker = new Database(path, { strict: true });
    locker.run("BEGIN IMMEDIATE");
    const service = new DeploymentService(new SqliteDeploymentRepository(path, 0));
    let caught: unknown;
    try {
      service.create({ service: "busy", version: "1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    if (!(caught instanceof ApiError)) throw new Error("Expected ApiError");
    expect(caught.statusCode).toBe(503);

    const app = createApp({ service });
    try {
      const response = await post(app.url.origin, "/deployments", { service: "busy", version: "1" });
      expect(response.status).toBe(503);
      expect(await parseResponse(response, parseError)).toEqual({ error: "Deployment storage is busy; retry the request" });
    } finally {
      await app.stop(true);
      service.close();
      locker.run("ROLLBACK");
      locker.close(false);
    }
  });

  test("does not disguise unexpected constraint corruption as a business 409", async () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    const deployment = service.create({ service: "corrupt-trigger", version: "1" });
    const app = createApp({ service });
    const database = new Database(path, { strict: true });
    database.run("DROP TRIGGER legal_deployment_transition");
    database.run(`
      CREATE TRIGGER legal_deployment_transition BEFORE UPDATE OF status ON deployments
      BEGIN SELECT RAISE(ABORT, 'corrupt_trigger'); END
    `);
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await post(
        app.url.origin,
        `/deployments/${deployment.id}/transitions`,
        { to: "running" },
      );
      expect(response.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      database.close(false);
      await app.stop(true);
      service.close();
    }
  });

  test("persists state through a complete Bun server stop and restart", async () => {
    const path = temporaryDatabase();
    const app = createApp({ databasePath: path });
    const firstBaseUrl = app.url.origin;
    const createResponse = await post(
      firstBaseUrl,
      "/deployments",
      { service: "api", version: "3.0.0" },
      { "idempotency-key": "api-3" },
    );
    expect(createResponse.status).toBe(201);
    const created = await parseResponse(createResponse, parseDeployment);
    await app.stop(true);

    const restartedApp = createApp({ databasePath: path });
    try {
      const page = await parseResponse(
        await fetch(`${restartedApp.url.origin}/deployments`),
        parseDeploymentPage,
      );
      expect(page.data.map(({ id }) => id)).toEqual([created.id]);
      const replay = await post(
        restartedApp.url.origin,
        "/deployments",
        { service: "api", version: "3.0.0" },
        { "idempotency-key": "api-3" },
      );
      expect(replay.status).toBe(201);
      expect(await parseResponse(replay, parseDeployment)).toMatchObject({ id: created.id });
    } finally {
      await restartedApp.stop(true);
    }
  });

  test("preserves the Bun.Server contract and makes shutdown idempotent", async () => {
    const app = createApp({ databasePath: temporaryDatabase() });
    expect(app.port).toBeGreaterThan(0);
    expect(app.hostname).toBe("127.0.0.1");
    expect(typeof app.reload).toBe("function");
    expect(typeof app.ref).toBe("function");
    const firstStop = app.stop(true);
    const secondStop = app.stop(true);
    expect(secondStop).toBe(firstStop);
    await firstStop;
  });

  test("closes owned SQLite storage when Bun server startup fails", async () => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    if (occupied.port === undefined) throw new Error("Expected occupied server port");
    const occupiedPort = occupied.port;
    const closeSpy = spyOn(DeploymentService.prototype, "close");
    try {
      expect(() => createApp({
        databasePath: temporaryDatabase(),
        port: occupiedPort,
      })).toThrow();
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
      await occupied.stop(true);
    }
  });

  test("coordinates the one-active constraint across separate server connections", async () => {
    const path = temporaryDatabase();
    const firstApp = createApp({ databasePath: path });
    const secondApp = createApp({ databasePath: path });
    try {
      const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => {
        const app = index % 2 === 0 ? firstApp : secondApp;
        return post(app.url.origin, "/deployments", {
          service: "shared",
          version: `1.0.${String(index)}`,
        });
      }));
      const statuses = responses.map(({ status }) => status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    } finally {
      await Promise.all([firstApp.stop(true), secondApp.stop(true)]);
    }
  });

  test("coordinates the one-active constraint across separate Bun processes", async () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();
    const results = await runWorkers(
      "sqlite-create-worker.ts",
      Array.from({ length: 12 }, (_, index) => [path, `1.0.${String(index)}`]),
    );

    expect(results.map(({ exitCode }) => exitCode)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(results.filter(({ output }) => output === "201")).toHaveLength(1);
    expect(results.filter(({ output }) => output === "409")).toHaveLength(11);
    expect(results.map(({ error }) => error).join("")).toBe("");
  });

  test("deduplicates one idempotent deployment across separate Bun processes", async () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();
    const results = await runWorkers(
      "sqlite-idempotency-worker.ts",
      Array.from({ length: 12 }, () => [path, "1.0.0", "shared-key"]),
    );

    expect(results.map(({ exitCode }) => exitCode)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(results.filter(({ output }) => output.startsWith("201:"))).toHaveLength(12);
    expect(new Set(results.map(({ output }) => output)).size).toBe(1);
    expect(results.map(({ error }) => error).join("")).toBe("");
  });

  test("rejects conflicting idempotency payloads across separate Bun processes", async () => {
    const path = temporaryDatabase();
    const repository = new SqliteDeploymentRepository(path);
    repository.close();
    const results = await runWorkers(
      "sqlite-idempotency-worker.ts",
      Array.from({ length: 12 }, (_, index) => [path, `1.0.${String(index)}`, "conflicting-key"]),
    );

    expect(results.map(({ exitCode }) => exitCode)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(results.filter(({ output }) => output.startsWith("201:"))).toHaveLength(1);
    expect(results.filter(({ output }) => output === "409")).toHaveLength(11);
    expect(results.map(({ error }) => error).join("")).toBe("");
  });

  test("allows only one competing terminal transition across separate Bun processes", async () => {
    const path = temporaryDatabase();
    const service = serviceFor(path);
    const deployment = service.create({ service: "transition-race", version: "1" });
    service.transition(deployment.id, "running");
    service.close();
    const results = await runWorkers(
      "sqlite-transition-worker.ts",
      Array.from({ length: 12 }, (_, index) => [
        path,
        deployment.id,
        index % 2 === 0 ? "succeeded" : "failed",
      ]),
    );

    expect(results.map(({ exitCode }) => exitCode)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(results.filter(({ output }) => output.startsWith("200:"))).toHaveLength(1);
    expect(results.filter(({ output }) => output === "409")).toHaveLength(11);
    expect(results.map(({ error }) => error).join("")).toBe("");
    const reopenedService = serviceFor(path);
    const finalStatus = reopenedService.list().data[0]?.status ?? "missing";
    expect(["succeeded", "failed"]).toContain(finalStatus);
    reopenedService.close();
  });
});
