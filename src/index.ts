import type { Plugin } from "@opencode-ai/plugin";
import { createGoalRuntime } from "./runtime";

const GoalPlugin = (async (input, options) => {
  const runtime = createGoalRuntime(input, options);
  return runtime.hooks();
}) satisfies Plugin;

export default GoalPlugin;
