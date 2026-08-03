import type { IdempotencyRecord } from "./deployment-repository.js";
import { isDeploymentStatus, type DeploymentStatus } from "./types.js";

export interface DeploymentRow {
  readonly sequence: number;
  readonly id: string;
  readonly service: string;
  readonly version: string;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TableInfoRow {
  readonly name: string;
  readonly notNull: number;
  readonly primaryKey: number;
}

export interface IndexListRow {
  readonly name: string;
  readonly uniqueIndex: number;
  readonly partial: number;
}

export interface ForeignKeyRow {
  readonly referencedTable: string;
  readonly sourceColumn: string;
  readonly targetColumn: string;
  readonly onDelete: string;
}

function record(value: unknown, context: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid SQLite ${context} row`);
  }
  return value;
}

function fieldValue(row: object, field: string): unknown {
  return Reflect.get(row, field);
}

function stringField(row: object, field: string, context: string): string {
  const value = fieldValue(row, field);
  if (typeof value !== "string") throw new Error(`Invalid SQLite ${context} row ${field}`);
  return value;
}

function safeIntegerField(
  row: object,
  field: string,
  context: string,
  minimum = 0,
): number {
  const value = fieldValue(row, field);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid SQLite ${context} row ${field}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite ${context} row ${field}: outside safe integer range`);
  }
  if (value < minimum) throw new Error(`Invalid SQLite ${context} row ${field}`);
  return value;
}

function flagField(row: object, field: string, context: string): number {
  const value = safeIntegerField(row, field, context);
  if (value > 1) throw new Error(`Invalid SQLite ${context} row ${field}`);
  return value;
}

export function parseDeploymentRow(value: unknown): DeploymentRow {
  const row = record(value, "deployment");
  const status = fieldValue(row, "status");
  if (!isDeploymentStatus(status)) throw new Error("Invalid SQLite deployment row status");
  return {
    sequence: safeIntegerField(row, "sequence", "deployment", 1),
    id: stringField(row, "id", "deployment"),
    service: stringField(row, "service", "deployment"),
    version: stringField(row, "version", "deployment"),
    status,
    createdAt: stringField(row, "createdAt", "deployment"),
    updatedAt: stringField(row, "updatedAt", "deployment"),
  };
}

export function parseIdempotencyRecord(value: unknown): IdempotencyRecord {
  const row = record(value, "idempotency");
  return {
    deploymentId: stringField(row, "deploymentId", "idempotency"),
    service: stringField(row, "service", "idempotency"),
    version: stringField(row, "version", "idempotency"),
  };
}

export function parseCountRow(value: unknown): number {
  return safeIntegerField(record(value, "count"), "count", "count");
}

export function parseUserVersionRow(value: unknown): number {
  return safeIntegerField(record(value, "user-version"), "userVersion", "user-version");
}

export function parseNameRow(value: unknown): string {
  return stringField(record(value, "name"), "name", "name");
}

export function parseSchemaSqlRow(value: unknown): string | null {
  const row = record(value, "schema SQL");
  if (fieldValue(row, "sql") === null) return null;
  return stringField(row, "sql", "schema SQL");
}

export function parseSequenceRow(value: unknown): number | null {
  const row = record(value, "sequence");
  if (fieldValue(row, "sequence") === null) return null;
  return safeIntegerField(row, "sequence", "sequence");
}

export function parseTableInfoRow(value: unknown): TableInfoRow {
  const row = record(value, "table-info");
  return {
    name: stringField(row, "name", "table-info"),
    notNull: flagField(row, "notNull", "table-info"),
    primaryKey: safeIntegerField(row, "primaryKey", "table-info"),
  };
}

export function parseIndexListRow(value: unknown): IndexListRow {
  const row = record(value, "index-list");
  return {
    name: stringField(row, "name", "index-list"),
    uniqueIndex: flagField(row, "uniqueIndex", "index-list"),
    partial: flagField(row, "partial", "index-list"),
  };
}

export function parseForeignKeyRow(value: unknown): ForeignKeyRow {
  const row = record(value, "foreign-key");
  return {
    referencedTable: stringField(row, "referencedTable", "foreign-key"),
    sourceColumn: stringField(row, "sourceColumn", "foreign-key"),
    targetColumn: stringField(row, "targetColumn", "foreign-key"),
    onDelete: stringField(row, "onDelete", "foreign-key"),
  };
}
