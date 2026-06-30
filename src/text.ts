export function nonEmptyTrimmedText(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}
