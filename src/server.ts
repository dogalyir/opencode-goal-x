import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { createGoalRuntime } from "./runtime";

export const GoalXServerPlugin = (async (input, options) => {
  const runtime = createGoalRuntime(input, options);
  return runtime.hooks();
}) satisfies Plugin;

const GoalXServerModule = {
  id: "opencode-goal-x",
  server: GoalXServerPlugin,
} satisfies PluginModule;

const GoalXServerDefaultPlugin = GoalXServerPlugin;

export default GoalXServerDefaultPlugin;
export { GoalXServerModule };
