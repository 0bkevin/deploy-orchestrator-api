import { ApiError } from "../../src/errors.js";
import { DeploymentService } from "../../src/deployment-service.js";
import { SqliteDeploymentRepository } from "../../src/sqlite-deployment-repository.js";

const databasePath = Bun.argv[2];
const deploymentId = Bun.argv[3];
const target = Bun.argv[4];
if (!databasePath || !deploymentId || !target) {
  throw new Error("database path, deployment id, and target are required");
}

const service = new DeploymentService(new SqliteDeploymentRepository(databasePath));
try {
  const deployment = service.transition(deploymentId, target);
  console.log(`200:${deployment.status}`);
} catch (error) {
  if (error instanceof ApiError) console.log(String(error.statusCode));
  else throw error;
} finally {
  service.close();
}
