import type { GoalBudget, GoalRuntimeOptions } from "./types";

export const PLUGIN_NAME = "opencode-goal-x";
export const STORE_VERSION = 1;
const DEFAULT_STATE_DIR = ".opencode/goals";
export const ACTIVE_DIR_NAME = "active";
export const ARCHIVE_DIR_NAME = "archive";
export const STATE_FILE_NAME = "state.json";
export const LEDGER_FILE_NAME = "ledger.jsonl";
export const METADATA_START = "<!-- opencode-goal-x:metadata";
export const METADATA_END = "opencode-goal-x:metadata -->";

export const DEFAULT_BUDGET: GoalBudget = {
  maxTurns: 80,
  maxRuntimeMs: 8 * 60 * 60 * 1000,
  maxTokens: 2_000_000,
  minDelayMs: 1_000,
  noProgressTurnsBeforePause: 4,
  noToolCallTurnsBeforePause: 3,
  noProgressTokenThreshold: 40,
  maxPromptFailures: 3,
};

export const DEFAULT_OPTIONS: GoalRuntimeOptions = {
  commandName: "goal",
  stateDir: DEFAULT_STATE_DIR,
  ...DEFAULT_BUDGET,
  requireAudit: true,
  auditTimeoutMs: 10 * 60 * 1000,
};

export const MEANINGFUL_PROGRESS_TOOLS = new Set([
  "bash",
  "edit",
  "write",
  "apply_patch",
  "read",
  "grep",
  "glob",
  "task",
  "todowrite",
  "complete_task",
  "skip_task",
  "pause_goal",
  "complete_goal",
  "abort_goal",
]);
