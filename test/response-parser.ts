import type { Deployment, DeploymentPage } from "../src/types.js";
import { isDeploymentStatus } from "../src/types.js";

export interface HealthPayload {
  readonly status: "ok";
  readonly uptime: number;
  readonly inFlight: number;
}

export interface ErrorPayload {
  readonly error: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function requireNullableString(value: unknown, name: string): string | null {
  return value === null ? null : requireString(value, name);
}

function requireNullableNumber(value: unknown, name: string): number | null {
  return value === null ? null : requireNumber(value, name);
}

export function parseDeployment(value: unknown): Deployment {
  const record = requireRecord(value, "deployment");
  const status = record.status;
  if (!isDeploymentStatus(status)) throw new TypeError("deployment.status is invalid");
  return {
    id: requireString(record.id, "deployment.id"),
    service: requireString(record.service, "deployment.service"),
    version: requireString(record.version, "deployment.version"),
    status,
    createdAt: requireString(record.createdAt, "deployment.createdAt"),
    updatedAt: requireString(record.updatedAt, "deployment.updatedAt"),
  };
}

export function parseDeploymentPage(value: unknown): DeploymentPage {
  const record = requireRecord(value, "deployment page");
  if (!Array.isArray(record.data)) throw new TypeError("deployment page data must be an array");
  return {
    data: record.data.map(parseDeployment),
    nextCursor: requireNullableString(record.nextCursor, "deployment page nextCursor"),
    nextOffset: requireNullableNumber(record.nextOffset, "deployment page nextOffset"),
  };
}

export function parseHealth(value: unknown): HealthPayload {
  const record = requireRecord(value, "health payload");
  if (record.status !== "ok") throw new TypeError("health status must be ok");
  return {
    status: record.status,
    uptime: requireNumber(record.uptime, "health uptime"),
    inFlight: requireNumber(record.inFlight, "health inFlight"),
  };
}

export function parseError(value: unknown): ErrorPayload {
  const record = requireRecord(value, "error payload");
  return { error: requireString(record.error, "error") };
}

export async function parseResponse<T>(
  response: Response,
  parser: (value: unknown) => T,
): Promise<T> {
  const value: unknown = await response.json();
  return parser(value);
}
