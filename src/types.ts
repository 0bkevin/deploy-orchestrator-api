export const deploymentStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
] as const;

export type DeploymentStatus = (typeof deploymentStatuses)[number];

export interface Deployment {
  id: string;
  service: string;
  version: string;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
}

export type TransitionTarget = Exclude<DeploymentStatus, "queued">;

export interface ListDeploymentsQuery {
  service?: string;
  status?: DeploymentStatus;
  limit?: number;
  offset?: number;
}
