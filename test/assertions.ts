import type { MaybeUndefined } from "../src/types";

export function requireDefined<Value>(value: MaybeUndefined<Value>, label: string): Value {
  if (value === undefined) throw new Error(`${label} missing`);
  return value;
}
