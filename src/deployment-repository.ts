import type { Deployment, DeploymentStatus } from "./types.js";

export interface IdempotencyRecord {
  readonly deploymentId: string;
  readonly service: string;
  readonly version: string;
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

export class StorageBusyError extends Error {
  constructor(readonly storageCause: unknown) {
    super("Deployment storage is busy");
    this.name = "StorageBusyError";
  }
}

export class StorageConstraintError extends Error {
  constructor(readonly storageCause: unknown) {
    super("Deployment storage rejected a constraint");
    this.name = "StorageConstraintError";
  }
}

export interface DeploymentRepository {
  close(): void;
  immediate<T>(operation: () => T): T;
  findIdempotencyKey(key: string): IdempotencyRecord | undefined;
  insertIdempotencyKey(key: string, deployment: Deployment): void;
  findById(id: string): Deployment | undefined;
  hasInFlight(service: string): boolean;
  insertDeployment(deployment: Deployment): void;
  updateStatus(
    id: string,
    expectedStatus: DeploymentStatus,
    targetStatus: DeploymentStatus,
    updatedAt: string,
  ): boolean;
  list(query: RepositoryListQuery): RepositoryPage;
  current(service: string): Deployment | undefined;
  countInFlight(): number;
}
