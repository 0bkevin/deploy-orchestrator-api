import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DeploymentService } from "../src/deployment-service.js";
import { createApp } from "../src/server.js";
import { SqliteDeploymentRepository } from "../src/sqlite-deployment-repository.js";
import type { Deployment, DeploymentPage } from "../src/types.js";

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
  return new DeploymentService(Date.now, new SqliteDeploymentRepository(path));
}

async function post(baseUrl: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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
    const secondPage = restartedService.list({ limit: 2, cursor: firstPage.nextCursor ?? undefined });
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

    database.query(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), "orders", "1", "queued", now, now);
    expect(() => database.query(`
      INSERT INTO deployments (id, service, version, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), "orders", "2", "running", now, now)).toThrow();

    expect(() => database.query(`
      INSERT INTO idempotency_keys (request_key, deployment_id, service, version)
      VALUES (?, ?, ?, ?)
    `).run("missing", "does-not-exist", "orders", "1")).toThrow();
    database.close(false);
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
    const created = await createResponse.json() as Deployment;
    await app.stop(true);

    const restartedApp = createApp({ databasePath: path });
    try {
      const page = await (await fetch(`${restartedApp.url.origin}/deployments`)).json() as DeploymentPage;
      expect(page.data.map(({ id }) => id)).toEqual([created.id]);
      const replay = await post(
        restartedApp.url.origin,
        "/deployments",
        { service: "api", version: "3.0.0" },
        { "idempotency-key": "api-3" },
      );
      expect(replay.status).toBe(201);
      expect(await replay.json()).toMatchObject({ id: created.id });
    } finally {
      await restartedApp.stop(true);
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
    const fixture = new URL("./fixtures/sqlite-create-worker.ts", import.meta.url).pathname;
    const workers = Array.from({ length: 12 }, (_, index) => Bun.spawn([
      Bun.argv[0] ?? "bun",
      fixture,
      path,
      `1.0.${String(index)}`,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    }));

    const results = await Promise.all(workers.map(async (worker) => {
      const outputPromise = new Response(worker.stdout).text();
      const errorPromise = new Response(worker.stderr).text();
      const exitCode = await worker.exited;
      return {
        exitCode,
        output: (await outputPromise).trim(),
        error: await errorPromise,
      };
    }));

    expect(results.map(({ exitCode }) => exitCode)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(results.filter(({ output }) => output === "201")).toHaveLength(1);
    expect(results.filter(({ output }) => output === "409")).toHaveLength(11);
    expect(results.map(({ error }) => error).join("")).toBe("");
  });
});
