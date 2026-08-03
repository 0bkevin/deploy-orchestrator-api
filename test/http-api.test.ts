import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/server.js";
import type { Deployment } from "../src/types.js";

interface Page {
  data: Deployment[];
  nextCursor: string | null;
  nextOffset: number | null;
}

describe("Deploy Orchestrator HTTP API", () => {
  let server: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeEach(() => {
    server = createApp();
    baseUrl = server.url.origin;
  });

  afterEach(async () => {
    await server.stop(true);
  });

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async function rawPost(path: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  async function createDeployment(
    service: string,
    version: string,
    idempotencyKey?: string,
  ): Promise<{ response: Response; deployment: Deployment }> {
    const headers: Record<string, string> = idempotencyKey ? { "idempotency-key": idempotencyKey } : {};
    const response = await post("/deployments", { service, version }, headers);
    const deployment = await response.json() as Deployment;
    return { response, deployment };
  }

  async function transition(id: string, to: string): Promise<Response> {
    return post(`/deployments/${id}/transitions`, { to });
  }

  test("creates queued deployments and deduplicates repeated idempotency keys", async () => {
    const first = await createDeployment("orders", "1.0.0", "orders-1");
    const replay = await createDeployment("orders", "1.0.0", "orders-1");

    expect(first.response.status).toBe(201);
    expect(first.deployment).toMatchObject({ service: "orders", version: "1.0.0", status: "queued" });
    expect(first.deployment.id).toBeTruthy();
    expect(first.deployment.createdAt).toBeTruthy();
    expect(first.deployment.updatedAt).toBeTruthy();
    expect(replay.response.status).toBe(201);
    expect(replay.deployment).toEqual(first.deployment);

    const list = await fetch(`${baseUrl}/deployments`);
    const page = await list.json() as Page;
    expect(page.data).toHaveLength(1);
  });

  test("rejects an idempotency key reused with a different payload", async () => {
    await createDeployment("orders", "1.0.0", "shared-key");
    const conflict = await post(
      "/deployments",
      { service: "payments", version: "9.0.0" },
      { "idempotency-key": "shared-key" },
    );
    expect(conflict.status).toBe(409);
    const errorBody = await conflict.json() as { error: string };
    expect(errorBody.error).toMatch(/different payload/i);
  });

  test("deduplicates concurrent requests that share an idempotency key", async () => {
    const responses = await Promise.all(Array.from(
      { length: 20 },
      () => createDeployment("notifications", "1.0.0", "notifications-1"),
    ));

    expect(responses.every(({ response }) => response.status === 201)).toBe(true);
    expect(new Set(responses.map(({ deployment }) => deployment.id))).toHaveLength(1);
    const page = await (await fetch(`${baseUrl}/deployments`)).json() as Page;
    expect(page.data).toHaveLength(1);
  });

  test("allows only one of twenty concurrent creates for the same service", async () => {
    const responses = await Promise.all(Array.from(
      { length: 20 },
      (_, index) => post("/deployments", { service: "payments", version: `1.0.${String(index)}` }),
    ));

    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    const health = await fetch(`${baseUrl}/health`);
    expect(await health.json()).toMatchObject({ status: "ok", inFlight: 1 });
  });

  test("applies transitions atomically and returns the required error codes", async () => {
    const { deployment } = await createDeployment("billing", "2.0.0");
    const concurrent = await Promise.all([
      transition(deployment.id, "running"),
      transition(deployment.id, "running"),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);

    expect((await transition("missing", "running")).status).toBe(404);
    expect((await transition(deployment.id, "queued")).status).toBe(400);

    const terminal = await Promise.all([
      transition(deployment.id, "succeeded"),
      transition(deployment.id, "failed"),
    ]);
    expect(terminal.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  test("exercises every legal lifecycle branch and terminal-state rejection over HTTP", async () => {
    const success = await createDeployment("success-path", "1.0.0");
    expect((await transition(success.deployment.id, "running")).status).toBe(200);
    expect((await transition(success.deployment.id, "succeeded")).status).toBe(200);
    expect((await transition(success.deployment.id, "rolled_back")).status).toBe(200);
    expect((await transition(success.deployment.id, "running")).status).toBe(409);

    const failure = await createDeployment("failure-path", "1.0.0");
    expect((await transition(failure.deployment.id, "running")).status).toBe(200);
    expect((await transition(failure.deployment.id, "failed")).status).toBe(200);
    expect((await transition(failure.deployment.id, "running")).status).toBe(409);

    const queued = await createDeployment("queued-path", "1.0.0");
    expect((await transition(queued.deployment.id, "succeeded")).status).toBe(409);
    expect((await transition(queued.deployment.id, "queued")).status).toBe(400);
  });

  test("enforces the active-deployment constraint while running and releases it at a terminal state", async () => {
    const active = await createDeployment("worker-pool", "1.0.0");
    await transition(active.deployment.id, "running");
    expect((await post("/deployments", { service: "worker-pool", version: "1.1.0" })).status).toBe(409);
    await transition(active.deployment.id, "failed");
    expect((await post("/deployments", { service: "worker-pool", version: "1.1.0" })).status).toBe(201);
  });

  test("lists newest first with combinable filters and offset pagination", async () => {
    const first = await createDeployment("catalog", "1.0.0");
    await transition(first.deployment.id, "running");
    await transition(first.deployment.id, "succeeded");
    await createDeployment("search", "3.0.0");
    const latest = await createDeployment("catalog", "1.1.0");

    const firstPageResponse = await fetch(`${baseUrl}/deployments?limit=2&offset=0`);
    const firstPage = await firstPageResponse.json() as Page;
    expect(firstPageResponse.status).toBe(200);
    expect(firstPage.data).toHaveLength(2);
    expect(firstPage.data[0]?.id).toBe(latest.deployment.id);
    expect(firstPage.nextOffset).toBe(2);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await (await fetch(`${baseUrl}/deployments?limit=2&offset=2`)).json() as Page;
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.nextOffset).toBeNull();

    const filtered = await (await fetch(`${baseUrl}/deployments?service=catalog&status=queued`)).json() as Page;
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.id).toBe(latest.deployment.id);
  });

  test("keeps cursor pagination stable when newer deployments are inserted", async () => {
    const oldest = await createDeployment("one", "1");
    await createDeployment("two", "2");
    const newest = await createDeployment("three", "3");

    const firstPage = await (await fetch(`${baseUrl}/deployments?limit=2`)).json() as Page;
    expect(firstPage.data[0]?.id).toBe(newest.deployment.id);
    expect(firstPage.nextCursor).toBeTruthy();

    await createDeployment("four", "4");
    const cursor = encodeURIComponent(firstPage.nextCursor ?? "");
    const secondPage = await (await fetch(`${baseUrl}/deployments?limit=2&cursor=${cursor}`)).json() as Page;
    expect(secondPage.data.map(({ id }) => id)).toEqual([oldest.deployment.id]);
    expect(secondPage.nextCursor).toBeNull();
  });

  test("restores the previous succeeded deployment after the latest is rolled back", async () => {
    const first = await createDeployment("web", "4.1.0");
    await transition(first.deployment.id, "running");
    await transition(first.deployment.id, "succeeded");
    const latest = await createDeployment("web", "4.2.0");
    await transition(latest.deployment.id, "running");
    await transition(latest.deployment.id, "succeeded");

    const current = await fetch(`${baseUrl}/services/web/current`);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ id: latest.deployment.id, status: "succeeded" });

    await transition(latest.deployment.id, "rolled_back");
    const restored = await fetch(`${baseUrl}/services/web/current`);
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ id: first.deployment.id, status: "succeeded" });
  });

  test("returns 404 when a service has no current succeeded deployment", async () => {
    expect((await fetch(`${baseUrl}/services/unknown/current`)).status).toBe(404);
    const deployment = await createDeployment("never-succeeded", "1.0.0");
    await transition(deployment.deployment.id, "running");
    await transition(deployment.deployment.id, "failed");
    expect((await fetch(`${baseUrl}/services/never-succeeded/current`)).status).toBe(404);
  });

  test("reports uptime and the exact queued plus running count", async () => {
    const initial = await fetch(`${baseUrl}/health`);
    expect(await initial.json()).toMatchObject({ status: "ok", inFlight: 0 });

    const { deployment } = await createDeployment("worker", "5.0.0");
    expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({ inFlight: 1 });
    await transition(deployment.id, "running");
    expect(await (await fetch(`${baseUrl}/health`)).json()).toMatchObject({ inFlight: 1 });
    await transition(deployment.id, "failed");
    const finalHealth = await (await fetch(`${baseUrl}/health`)).json() as { uptime: number; inFlight: number };
    expect(finalHealth.inFlight).toBe(0);
    expect(finalHealth.uptime).toBeGreaterThanOrEqual(0);
  });

  test("rejects malformed payloads, filters, pagination and path encoding with useful 400s", async () => {
    expect((await post("/deployments", { service: "", version: 1 })).status).toBe(400);
    expect((await rawPost("/deployments", "{not-json")).status).toBe(400);
    expect((await rawPost("/deployments", "[]")).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?service=`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?status=`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?status=unknown`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?limit=0`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?limit=101`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?offset=-1`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?offset=9007199254740992`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?cursor=bad`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/deployments?cursor=v1.MA&offset=0`)).status).toBe(400);
    expect((await post("/deployments", { service: "x", version: "1" }, { "idempotency-key": " " })).status).toBe(400);
    expect((await post("/deployments/%/transitions", { to: "running" })).status).toBe(400);
    expect((await fetch(`${baseUrl}/unknown-route`)).status).toBe(404);
  });
});
