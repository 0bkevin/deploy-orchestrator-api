import { ApiError } from "./errors.js";
import { SqliteDeploymentRepository } from "./sqlite-deployment-repository.js";
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
  private readonly startedAt: number;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly repository = new SqliteDeploymentRepository(),
  ) {
    this.startedAt = now();
  }

  close(): void {
    this.repository.close();
  }

  create(input: Record<string, unknown>, idempotencyKey?: string): Deployment {
    const service = this.requireNonEmptyString(input.service, "service");
    const version = this.requireNonEmptyString(input.version, "version");

    return this.repository.immediate(() => {
      if (idempotencyKey) {
        const original = this.repository.findIdempotencyKey(idempotencyKey);
        if (original) {
          if (original.service !== service || original.version !== version) {
            throw new ApiError(409, "Idempotency-Key was already used with a different payload");
          }
          return this.mustFind(original.deploymentId);
        }
      }

      if (this.repository.hasInFlight(service)) {
        throw new ApiError(409, `Service '${service}' already has a queued or running deployment`);
      }

      const now = new Date(this.now()).toISOString();
      const deployment: Deployment = {
        id: crypto.randomUUID(),
        service,
        version,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      this.repository.insertDeployment(deployment);
      if (idempotencyKey) this.repository.insertIdempotencyKey(idempotencyKey, deployment);
      return deployment;
    });
  }

  transition(id: string, target: unknown): Deployment {
    if (!deploymentStatuses.includes(target as DeploymentStatus) || target === "queued") {
      throw new ApiError(400, "'to' must be running, succeeded, failed, or rolled_back");
    }

    return this.repository.immediate(() => {
      const deployment = this.mustFind(id);
      const to = target as TransitionTarget;
      if (!legalTransitions[deployment.status].includes(to)) {
        throw new ApiError(409, `Cannot transition from '${deployment.status}' to '${to}'`);
      }

      const updatedAt = new Date(this.now()).toISOString();
      if (!this.repository.updateStatus(id, deployment.status, to, updatedAt)) {
        throw new ApiError(409, `Deployment '${id}' changed during the transition`);
      }
      return this.mustFind(id);
    });
  }

  list(query: ListDeploymentsQuery = {}): DeploymentPage {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, "limit must be an integer between 1 and 100");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ApiError(400, "offset must be a non-negative integer");
    }
    if (query.status !== undefined && !deploymentStatuses.includes(query.status)) {
      throw new ApiError(400, "Invalid status filter");
    }
    if (query.cursor !== undefined && query.offset !== undefined) {
      throw new ApiError(400, "cursor and offset cannot be combined");
    }

    const beforeSequence = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    const page = this.repository.list({
      service: query.service,
      status: query.status,
      limit,
      offset,
      beforeSequence,
    });
    return {
      data: page.data,
      nextCursor: page.hasMore && page.lastSequence !== null
        ? this.encodeCursor(page.lastSequence)
        : null,
      nextOffset: query.cursor === undefined && page.hasMore
        ? offset + page.data.length
        : null,
    };
  }

  current(service: string): Deployment {
    const current = this.repository.current(service);
    if (!current) throw new ApiError(404, `No current succeeded deployment for '${service}'`);
    return current;
  }

  health(): { status: "ok"; uptime: number; inFlight: number } {
    return {
      status: "ok",
      uptime: Math.floor((this.now() - this.startedAt) / 1000),
      inFlight: this.repository.countInFlight(),
    };
  }

  private mustFind(id: string): Deployment {
    const deployment = this.repository.findById(id);
    if (!deployment) throw new ApiError(404, `Deployment '${id}' was not found`);
    return deployment;
  }

  private encodeCursor(sequence: number): string {
    return `v1.${sequence.toString(36)}`;
  }

  private decodeCursor(cursor: string): number {
    const match = /^v1\.([0-9a-z]+)$/.exec(cursor);
    if (!match?.[1]) throw new ApiError(400, "cursor is invalid");

    const sequence = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(sequence) || sequence.toString(36) !== match[1]) {
      throw new ApiError(400, "cursor is invalid");
    }
    return sequence;
  }

  private requireNonEmptyString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, `'${field}' must be a non-empty string`);
    }
    return value.trim();
  }
}
