import { ApiError } from "./errors.js";
import {
  StorageBusyError,
  StorageConstraintError,
  type DeploymentRepository,
} from "./deployment-repository.js";
import {
  isDeploymentStatus,
  isTransitionTarget,
  type Deployment,
  type DeploymentPage,
  type DeploymentStatus,
  type ListDeploymentsQuery,
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
    private readonly repository: DeploymentRepository,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  close(): void {
    this.repository.close();
  }

  create(input: Record<string, unknown>, idempotencyKey?: string): Deployment {
    const service = this.requireNonEmptyString(input.service, "service");
    const version = this.requireNonEmptyString(input.version, "version");

    try {
      return this.repository.immediate(() => this.createInsideTransaction(service, version, idempotencyKey));
    } catch (error) {
      if (error instanceof StorageBusyError) {
        throw new ApiError(503, "Deployment storage is busy; retry the request");
      }
      if (!(error instanceof StorageConstraintError)) throw error;

      try {
        return this.repository.immediate(() => {
          const replay = this.findIdempotentReplay(service, version, idempotencyKey);
          if (replay) return replay;
          if (this.repository.hasInFlight(service)) {
            throw new ApiError(409, `Service '${service}' already has a queued or running deployment`);
          }
          throw error;
        });
      } catch (recoveryError) {
        if (recoveryError instanceof StorageBusyError) {
          throw new ApiError(503, "Deployment storage is busy; retry the request");
        }
        throw recoveryError;
      }
    }
  }

  transition(id: string, target: unknown): Deployment {
    if (!isTransitionTarget(target)) {
      throw new ApiError(400, "'to' must be running, succeeded, failed, or rolled_back");
    }

    try {
      return this.repository.immediate(() => {
        const deployment = this.mustFind(id);
        const to = target;
        if (!legalTransitions[deployment.status].includes(to)) {
          throw new ApiError(409, `Cannot transition from '${deployment.status}' to '${to}'`);
        }

        const updatedAt = new Date(this.now()).toISOString();
        if (!this.repository.updateStatus(id, deployment.status, to, updatedAt)) {
          throw new ApiError(409, `Deployment '${id}' changed during the transition`);
        }
        return this.mustFind(id);
      });
    } catch (error) {
      if (error instanceof StorageBusyError) {
        throw new ApiError(503, "Deployment storage is busy; retry the request");
      }
      throw error;
    }
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
    if (query.status !== undefined && !isDeploymentStatus(query.status)) {
      throw new ApiError(400, "Invalid status filter");
    }
    if (query.cursor !== undefined && query.offset !== undefined) {
      throw new ApiError(400, "cursor and offset cannot be combined");
    }

    const service = query.service === undefined
      ? undefined
      : this.requireNonEmptyString(query.service, "service filter");
    const beforeSequence = query.cursor === undefined ? undefined : this.decodeCursor(query.cursor);
    const filters = {
      ...(service === undefined ? {} : { service }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(beforeSequence === undefined ? {} : { beforeSequence }),
      limit,
      offset,
    };
    const page = this.repository.list(filters);
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
    const normalizedService = service.trim();
    const current = this.repository.current(normalizedService);
    if (!current) throw new ApiError(404, `No current succeeded deployment for '${normalizedService}'`);
    return current;
  }

  health(): { status: "ok"; uptime: number; inFlight: number } {
    return {
      status: "ok",
      uptime: Math.floor((this.now() - this.startedAt) / 1000),
      inFlight: this.repository.countInFlight(),
    };
  }

  private createInsideTransaction(
    service: string,
    version: string,
    idempotencyKey?: string,
  ): Deployment {
    const replay = this.findIdempotentReplay(service, version, idempotencyKey);
    if (replay) return replay;
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
  }

  private findIdempotentReplay(
    service: string,
    version: string,
    idempotencyKey?: string,
  ): Deployment | undefined {
    if (!idempotencyKey) return undefined;
    const original = this.repository.findIdempotencyKey(idempotencyKey);
    if (!original) return undefined;
    if (original.service !== service || original.version !== version) {
      throw new ApiError(409, "Idempotency-Key was already used with a different payload");
    }
    return this.mustFind(original.deploymentId);
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
