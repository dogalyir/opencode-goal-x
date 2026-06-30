import type { GoalBudget, GoalRuntimeOptions } from "./types";

export const PLUGIN_NAME = "opencode-goal-x";
export const STORE_VERSION = 1;
export const DEFAULT_STATE_DIR = ".opencode/goals";
export const ACTIVE_DIR_NAME = "active";
export const ARCHIVE_DIR_NAME = "archive";
export const STATE_FILE_NAME = "state.json";
export const LEDGER_FILE_NAME = "ledger.jsonl";
export const LOCK_DIR_NAME = ".write-lock";
export const METADATA_START = "<!-- opencode-goal-x:metadata";
export const METADATA_END = "opencode-goal-x:metadata -->";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const DEFAULT_MAX_RUNTIME_HOURS = 8;
const DEFAULT_AUDIT_TIMEOUT_MINUTES = 10;

export const DEFAULT_BUDGET: GoalBudget = {
  maxTurns: 80,
  maxRuntimeMs: DEFAULT_MAX_RUNTIME_HOURS * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND,
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
  auditTimeoutMs: DEFAULT_AUDIT_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND,
  readonlyAuditor: true,
  todoSync: true,
  maxTaskCount: 100,
  maxSubtaskDepth: 3,
  strictTaskContracts: true,
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
