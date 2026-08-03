import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import {
  deploymentStatuses,
  type Deployment,
  type DeploymentPage,
  type DeploymentStatus,
  type ListDeploymentsQuery,
  type TransitionTarget,
} from "./types.js";

const legalTransitions: Readonly<Record<DeploymentStatus, readonly DeploymentStatus[]>> = {
  queued: ["running"],
  running: ["succeeded", "failed"],
  succeeded: ["rolled_back"],
  failed: [],
  rolled_back: [],
};

export class DeploymentService {
  private readonly deployments = new Map<string, Deployment>();
  private readonly idempotencyKeys = new Map<string, {
    deploymentId: string;
    service: string;
    version: string;
  }>();
  private readonly creationOrder = new Map<string, number>();
  private readonly startedAt = Date.now();
  private nextCreationOrder = 0;

  create(input: Record<string, unknown>, idempotencyKey?: string): Deployment {
    const service = this.requireNonEmptyString(input.service, "service");
    const version = this.requireNonEmptyString(input.version, "version");

    if (idempotencyKey) {
      const original = this.idempotencyKeys.get(idempotencyKey);
      if (original) {
        if (original.service !== service || original.version !== version) {
          throw new ApiError(409, "Idempotency-Key was already used with a different payload");
        }
        return this.copy(this.mustFind(original.deploymentId));
      }
    }

    // This method contains no await points: in a single Node process the check and
    // insert are one synchronous critical section, so two HTTP handlers cannot interleave here.
    if (this.hasInFlight(service)) {
      throw new ApiError(409, `Service '${service}' already has a queued or running deployment`);
    }

    const now = new Date().toISOString();
    const deployment: Deployment = {
      id: randomUUID(), service, version, status: "queued", createdAt: now, updatedAt: now,
    };
    this.deployments.set(deployment.id, deployment);
    this.creationOrder.set(deployment.id, this.nextCreationOrder++);
    if (idempotencyKey) {
      this.idempotencyKeys.set(idempotencyKey, {
        deploymentId: deployment.id,
        service,
        version,
      });
    }
    return this.copy(deployment);
  }

  transition(id: string, target: unknown): Deployment {
    if (!deploymentStatuses.includes(target as DeploymentStatus) || target === "queued") {
      throw new ApiError(400, "'to' must be running, succeeded, failed, or rolled_back");
    }

    // Like create(), this read/validate/write sequence has no await point and is atomic in-process.
    const deployment = this.mustFind(id);
    const to = target as TransitionTarget;
    if (!legalTransitions[deployment.status].includes(to)) {
      throw new ApiError(409, `Cannot transition from '${deployment.status}' to '${to}'`);
    }
    const updated: Deployment = { ...deployment, status: to, updatedAt: new Date().toISOString() };
    this.deployments.set(id, updated);
    return this.copy(updated);
  }

  list(query: ListDeploymentsQuery = {}): DeploymentPage {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, "limit must be an integer between 1 and 100");
    if (!Number.isInteger(offset) || offset < 0) throw new ApiError(400, "offset must be a non-negative integer");
    if (query.status !== undefined && !deploymentStatuses.includes(query.status)) throw new ApiError(400, "Invalid status filter");
    if (query.cursor !== undefined && query.offset !== undefined) throw new ApiError(400, "cursor and offset cannot be combined");

    const cursorOrder = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);

    const matching = [...this.deployments.values()]
      .filter((item) => query.service === undefined || item.service === query.service)
      .filter((item) => query.status === undefined || item.status === query.status)
      .filter((item) => cursorOrder === undefined || this.orderOf(item) < cursorOrder)
      .sort((a, b) => this.orderOf(b) - this.orderOf(a));
    const pageRecords = matching.slice(offset, offset + limit);
    const hasMore = offset + pageRecords.length < matching.length;
    const lastRecord = pageRecords.at(-1);
    const data = pageRecords.map((deployment) => this.copy(deployment));
    const nextCursor = hasMore && lastRecord ? this.encodeCursor(this.orderOf(lastRecord)) : null;
    const nextOffset = query.cursor === undefined && hasMore ? offset + data.length : null;
    return { data, nextCursor, nextOffset };
  }

  current(service: string): Deployment {
    const current = [...this.deployments.values()]
      .filter((item) => item.service === service && item.status === "succeeded")
      .sort((a, b) => this.orderOf(b) - this.orderOf(a))[0];
    if (!current) throw new ApiError(404, `No current succeeded deployment for '${service}'`);
    return this.copy(current);
  }

  health(): { status: "ok"; uptime: number; inFlight: number } {
    return {
      status: "ok",
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      inFlight: [...this.deployments.values()].filter((item) => item.status === "queued" || item.status === "running").length,
    };
  }

  private hasInFlight(service: string): boolean {
    return [...this.deployments.values()].some((item) => item.service === service && (item.status === "queued" || item.status === "running"));
  }

  private mustFind(id: string): Deployment {
    const deployment = this.deployments.get(id);
    if (!deployment) throw new ApiError(404, `Deployment '${id}' was not found`);
    return deployment;
  }

  private orderOf(deployment: Deployment): number {
    return this.creationOrder.get(deployment.id) ?? -1;
  }

  private copy(deployment: Deployment): Deployment {
    return { ...deployment };
  }

  private encodeCursor(order: number): string {
    return `v1.${Buffer.from(String(order)).toString("base64url")}`;
  }

  private decodeCursor(cursor: string): number {
    const match = /^v1\.([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match?.[1]) throw new ApiError(400, "cursor is invalid");

    const decoded = Buffer.from(match[1], "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new ApiError(400, "cursor is invalid");
    const order = Number(decoded);
    if (!Number.isSafeInteger(order)) throw new ApiError(400, "cursor is invalid");
    return order;
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new ApiError(400, `'${field}' must be a non-empty string`);
    return value.trim();
  }
}
