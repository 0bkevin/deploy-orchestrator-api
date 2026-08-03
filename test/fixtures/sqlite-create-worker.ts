import { ApiError } from "../../src/errors.js";
import { DeploymentService } from "../../src/deployment-service.js";
import { SqliteDeploymentRepository } from "../../src/sqlite-deployment-repository.js";

const databasePath = Bun.argv[2];
const version = Bun.argv[3];
if (!databasePath || !version) throw new Error("database path and version are required");

const service = new DeploymentService(Date.now, new SqliteDeploymentRepository(databasePath));
try {
  service.create({ service: "multi-process", version });
  console.log("201");
} catch (error) {
  if (error instanceof ApiError) console.log(String(error.statusCode));
  else throw error;
} finally {
  service.close();
}
