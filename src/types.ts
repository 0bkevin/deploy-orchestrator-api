export const deploymentStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
] as const;

export type DeploymentStatus = (typeof deploymentStatuses)[number];

export interface Deployment {
  readonly id: string;
  readonly service: string;
  readonly version: string;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TransitionTarget = Exclude<DeploymentStatus, "queued">;

export interface ListDeploymentsQuery {
  service?: string;
  status?: DeploymentStatus;
  limit?: number;
  offset?: number;
}
