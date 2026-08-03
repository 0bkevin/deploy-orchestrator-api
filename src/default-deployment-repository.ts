import type { DeploymentRepository } from "./deployment-repository.js";
import { SqliteDeploymentRepository } from "./sqlite-deployment-repository.js";

export function createDefaultDeploymentRepository(): DeploymentRepository {
  return new SqliteDeploymentRepository();
}
