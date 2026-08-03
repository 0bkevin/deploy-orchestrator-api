import { ApiError } from "../../src/errors.js";
import { DeploymentService } from "../../src/deployment-service.js";
import { SqliteDeploymentRepository } from "../../src/sqlite-deployment-repository.js";

const databasePath = Bun.argv[2];
const version = Bun.argv[3];
const idempotencyKey = Bun.argv[4];
if (!databasePath || !version || !idempotencyKey) {
  throw new Error("database path, version, and idempotency key are required");
}

const service = new DeploymentService(Date.now, new SqliteDeploymentRepository(databasePath));
try {
  const deployment = service.create(
    { service: "multi-process-idempotency", version },
    idempotencyKey,
  );
  console.log(`201:${deployment.id}`);
} catch (error) {
  if (error instanceof ApiError) console.log(String(error.statusCode));
  else throw error;
} finally {
  service.close();
}
