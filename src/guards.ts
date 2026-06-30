import type { MaybeUndefined, UnknownRecord } from "./types";

export type { UnknownRecord } from "./types";

export function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object") return false;
  if (value === null) return false;
  return Array.isArray(value) === false;
}

export function nonBlankStringField(record: UnknownRecord, field: string): MaybeUndefined<string> {
  const value = record[field];
  if (typeof value !== "string") return undefined;
  if (value.trim().length === 0) return undefined;
  return value;
}

export function booleanField(record: UnknownRecord, field: string): MaybeUndefined<boolean> {
  const value = record[field];
  if (typeof value !== "boolean") return undefined;
  return value;
}
