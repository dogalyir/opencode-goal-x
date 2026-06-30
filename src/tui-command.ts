import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

type ExecuteCommandParameters = NonNullable<Parameters<TuiPluginApi["client"]["tui"]["executeCommand"]>[0]>;

export function tuiCommandParameters(directory: string, command: string): ExecuteCommandParameters {
  return { directory, command };
}
