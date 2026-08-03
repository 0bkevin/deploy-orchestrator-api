import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { DeploymentService } from "../src/deployment-service.js";
import { decodePathSegment } from "../src/path.js";

describe("DeploymentService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces the state machine and rejects illegal transitions", () => {
    const service = new DeploymentService();
    const deployment = service.create({ service: "billing", version: "1.0.0" });
    expect(service.transition(deployment.id, "running").status).toBe("running");
    expect(service.transition(deployment.id, "succeeded").status).toBe("succeeded");
    expect(() => service.transition(deployment.id, "running")).toThrow(ApiError);
    expect(() => service.transition(deployment.id, "running")).toThrow(/Cannot transition/);
  });

  it("allows only one in-flight deployment per service", () => {
    const service = new DeploymentService();
    service.create({ service: "payments", version: "1.0.0" });
    expect(() => service.create({ service: "payments", version: "1.0.1" })).toThrow(/already has/);
    const other = service.create({ service: "search", version: "1.0.0" });
    expect(other.status).toBe("queued");
  });

  it("returns the original deployment for repeated idempotency keys", () => {
    const service = new DeploymentService();
    const first = service.create({ service: "orders", version: "2.0.0" }, "request-123");
    const repeated = service.create({ service: "orders", version: "2.0.0" }, "request-123");
    expect(repeated).toEqual(first);
    expect(service.list().data).toHaveLength(1);
  });

  it("rejects an idempotency key reused with a different payload", () => {
    const service = new DeploymentService();
    service.create({ service: "orders", version: "2.0.0" }, "request-123");
    expect(() => service.create(
      { service: "payments", version: "9.0.0" },
      "request-123",
    )).toThrow(/different payload/);
  });

  it("does not expose mutable references to stored deployments", () => {
    const service = new DeploymentService();
    const deployment = service.create({ service: "catalog", version: "1.0.0" });
    const external = deployment as { status: string };
    external.status = "succeeded";

    expect(service.list().data[0]?.status).toBe("queued");
    expect(() => service.current("catalog")).toThrow(ApiError);
  });

  it("reports a rolled back deployment as not current", () => {
    const service = new DeploymentService();
    const deployment = service.create({ service: "catalog", version: "1.0.0" });
    service.transition(deployment.id, "running");
    service.transition(deployment.id, "succeeded");
    expect(service.current("catalog").id).toBe(deployment.id);
    service.transition(deployment.id, "rolled_back");
    expect(() => service.current("catalog")).toThrow(ApiError);
  });

  it("returns later creations first when timestamps are identical", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const service = new DeploymentService();
    const first = service.create({ service: "first", version: "1" });
    const second = service.create({ service: "second", version: "1" });
    expect(service.list().data.map((item) => item.id)).toEqual([second.id, first.id]);
    vi.useRealTimers();
  });

  it("rejects malformed encoded path segments as client errors", () => {
    expect(() => decodePathSegment("%", "id")).toThrow(ApiError);
    expect(() => decodePathSegment("%", "id")).toThrow(/invalid URL encoding/);
    expect(decodePathSegment("orders%20api", "name")).toBe("orders api");
  });

  it("rejects an empty status filter instead of silently ignoring it", () => {
    const service = new DeploymentService();
    expect(() => service.list({ status: "" as never })).toThrow(/Invalid status filter/);
  });
});
