export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (!("code" in error)) return undefined;
  const code = error.code;
  if (typeof code !== "string") return undefined;
  return code;
}
