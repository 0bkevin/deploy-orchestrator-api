import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ApiError } from "./errors.js";
import { DeploymentService } from "./deployment-service.js";
import { decodePathSegment } from "./path.js";
import { deploymentStatuses, type DeploymentStatus } from "./types.js";

const transitionPath = /^\/deployments\/([^/]+)\/transitions$/;
const currentPath = /^\/services\/([^/]+)\/current$/;

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk));
  }
  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
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

async function handleRequest(
  service: DeploymentService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      send(response, 200, service.health());
      return;
    }

    if (method === "POST" && url.pathname === "/deployments") {
      const body = asRecord(await readJson(request));
      const keyHeader = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      if (idempotencyKey !== undefined && !idempotencyKey.trim()) {
        throw new ApiError(400, "Idempotency-Key cannot be empty");
      }
      send(response, 201, service.create(body, idempotencyKey));
      return;
    }

    const transitionMatch = transitionPath.exec(url.pathname);
    const deploymentId = transitionMatch?.[1];
    if (method === "POST" && deploymentId !== undefined) {
      const body = asRecord(await readJson(request));
      send(response, 200, service.transition(decodePathSegment(deploymentId, "id"), body.to));
      return;
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
      send(response, 200, service.list({
        service: serviceFilter ?? undefined,
        status: (status as DeploymentStatus | null) ?? undefined,
        limit: parseInteger(url.searchParams.get("limit"), "limit"),
        cursor: url.searchParams.get("cursor") ?? undefined,
        offset: parseInteger(url.searchParams.get("offset"), "offset"),
      }));
      return;
    }

    const currentMatch = currentPath.exec(url.pathname);
    const serviceName = currentMatch?.[1];
    if (method === "GET" && serviceName !== undefined) {
      send(response, 200, service.current(decodePathSegment(serviceName, "name")));
      return;
    }

    send(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ApiError) {
      send(response, error.statusCode, { error: error.message });
      return;
    }
    console.error(error);
    send(response, 500, { error: "Internal server error" });
  }
}

export function createApp(service = new DeploymentService()): Server {
  return createServer((request, response) => {
    void handleRequest(service, request, response);
  });
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  const port = parsePort(process.env.PORT ?? "3000");
  createApp().listen(port, () => {
    console.log(`Deploy Orchestrator API listening on http://localhost:${String(port)}`);
  });
}
