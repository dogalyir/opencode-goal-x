import type { MaybeUndefined } from "./types";

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): MaybeUndefined<string> {
  if ((error instanceof Error) === false) return undefined;
  if (("code" in error) === false) return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  return code;
}
