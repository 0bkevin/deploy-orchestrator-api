export const deploymentStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
] as const;

export type DeploymentStatus = (typeof deploymentStatuses)[number];

export function isDeploymentStatus(value: unknown): value is DeploymentStatus {
  return deploymentStatuses.some((status) => status === value);
}

export interface Deployment {
  readonly id: string;
  readonly service: string;
  readonly version: string;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TransitionTarget = Exclude<DeploymentStatus, "queued">;

export function isTransitionTarget(value: unknown): value is TransitionTarget {
  return isDeploymentStatus(value) && value !== "queued";
}

export interface ListDeploymentsQuery {
  readonly service?: string;
  readonly status?: DeploymentStatus;
  readonly limit?: number;
  readonly cursor?: string;
  readonly offset?: number;
}

export interface DeploymentPage {
  readonly data: readonly Deployment[];
  readonly nextCursor: string | null;
  readonly nextOffset: number | null;
}
