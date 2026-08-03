import { ApiError } from "./errors.js";
import { DeploymentService } from "./deployment-service.js";
import { decodePathSegment } from "./path.js";
import { SqliteDeploymentRepository } from "./sqlite-deployment-repository.js";
import { deploymentStatuses, type DeploymentStatus } from "./types.js";

const transitionPath = /^\/deployments\/([^/]+)\/transitions$/;
const currentPath = /^\/services\/([^/]+)\/current$/;

function json(status: number, payload: unknown): Response {
  return Response.json(payload, { status });
}

async function readJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (!body) return {};

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function parseInteger(value: string | null, field: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new ApiError(400, `${field} must be a non-negative integer`);

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ApiError(400, `${field} must be a safe integer`);
  return parsed;
}

function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("PORT must be an integer between 1 and 65535");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

async function handleRequest(service: DeploymentService, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "GET" && url.pathname === "/health") {
      return json(200, service.health());
    }

    if (method === "POST" && url.pathname === "/deployments") {
      const body = asRecord(await readJson(request));
      const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
      if (idempotencyKey !== undefined && !idempotencyKey.trim()) {
        throw new ApiError(400, "Idempotency-Key cannot be empty");
      }
      return json(201, service.create(body, idempotencyKey));
    }

    const transitionMatch = transitionPath.exec(url.pathname);
    const deploymentId = transitionMatch?.[1];
    if (method === "POST" && deploymentId !== undefined) {
      const body = asRecord(await readJson(request));
      return json(200, service.transition(decodePathSegment(deploymentId, "id"), body.to));
    }

    if (method === "GET" && url.pathname === "/deployments") {
      const status = url.searchParams.get("status");
      const serviceFilter = url.searchParams.get("service");
      if (status !== null && !deploymentStatuses.includes(status as DeploymentStatus)) {
        throw new ApiError(400, "Invalid status filter");
      }
      if (serviceFilter !== null && !serviceFilter.trim()) {
        throw new ApiError(400, "service filter must be a non-empty string");
      }
      return json(200, service.list({
        service: serviceFilter ?? undefined,
        status: (status as DeploymentStatus | null) ?? undefined,
        limit: parseInteger(url.searchParams.get("limit"), "limit"),
        cursor: url.searchParams.get("cursor") ?? undefined,
        offset: parseInteger(url.searchParams.get("offset"), "offset"),
      }));
    }

    const currentMatch = currentPath.exec(url.pathname);
    const serviceName = currentMatch?.[1];
    if (method === "GET" && serviceName !== undefined) {
      return json(200, service.current(decodePathSegment(serviceName, "name")));
    }

    return json(404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ApiError) return json(error.statusCode, { error: error.message });
    console.error(error);
    return json(500, { error: "Internal server error" });
  }
}

interface AppOptions {
  readonly service?: DeploymentService;
  readonly databasePath?: string;
  readonly hostname?: string;
  readonly port?: number;
}

export function createApp(options: AppOptions = {}): Bun.Server<undefined> {
  const ownsService = options.service === undefined;
  const service = options.service ?? new DeploymentService(
    Date.now,
    new SqliteDeploymentRepository(options.databasePath),
  );
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 0,
    fetch: (request) => handleRequest(service, request),
  });
  const originalStop = server.stop.bind(server);
  let shutdown: Promise<void> | undefined;
  server.stop = (closeActiveConnections = false) => {
    shutdown ??= (async () => {
      try {
        await originalStop(closeActiveConnections);
      } finally {
        if (ownsService) service.close();
      }
    })();
    return shutdown;
  };
  return server;
}

if (import.meta.main) {
  const port = parsePort(Bun.env.PORT ?? "3000");
  const app = createApp({
    port,
    databasePath: Bun.env.DATABASE_PATH ?? "deployments.sqlite",
  });
  console.log(`Deploy Orchestrator API listening on ${app.url.origin}`);
}
