import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ApiError } from "./errors.js";
import { DeploymentService } from "./deployment-service.js";
import { decodePathSegment } from "./path.js";
import { deploymentStatuses, type DeploymentStatus } from "./types.js";

const service = new DeploymentService();

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ApiError(400, "Request body must be valid JSON"); }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "Request body must be a JSON object");
  return value as Record<string, unknown>;
}

function parseInteger(value: string | null, field: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new ApiError(400, `${field} must be a non-negative integer`);
  return Number(value);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") return send(response, 200, service.health());

    if (method === "POST" && url.pathname === "/deployments") {
      const body = asRecord(await readJson(request));
      const keyHeader = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      if (idempotencyKey !== undefined && !idempotencyKey.trim()) throw new ApiError(400, "Idempotency-Key cannot be empty");
      return send(response, 201, service.create(body, idempotencyKey));
    }

    const transitionMatch = url.pathname.match(/^\/deployments\/([^/]+)\/transitions$/);
    if (method === "POST" && transitionMatch) {
      const body = asRecord(await readJson(request));
      return send(response, 200, service.transition(decodePathSegment(transitionMatch[1]!, "id"), body.to));
    }

    if (method === "GET" && url.pathname === "/deployments") {
      const status = url.searchParams.get("status");
      if (status !== null && !deploymentStatuses.includes(status as DeploymentStatus)) throw new ApiError(400, "Invalid status filter");
      return send(response, 200, service.list({
        service: url.searchParams.get("service") ?? undefined,
        status: (status as DeploymentStatus | null) ?? undefined,
        limit: parseInteger(url.searchParams.get("limit"), "limit"),
        offset: parseInteger(url.searchParams.get("offset"), "offset"),
      }));
    }

    const currentMatch = url.pathname.match(/^\/services\/([^/]+)\/current$/);
    if (method === "GET" && currentMatch) return send(response, 200, service.current(decodePathSegment(currentMatch[1]!, "name")));

    return send(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ApiError) return send(response, error.statusCode, { error: error.message });
    console.error(error);
    return send(response, 500, { error: "Internal server error" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Deploy Orchestrator API listening on http://localhost:${port}`));
