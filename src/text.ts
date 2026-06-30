import type { MaybeUndefined } from "./types";

export function nonEmptyTrimmedText(value: string): MaybeUndefined<string> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
