import * as fs from "node:fs";
import { DEFAULT_STATE_DIR } from "./defaults";
import { errorMessage } from "./errors";
import { countTasks, focusedGoal, openGoals } from "./goal";
import { isRecord, nonBlankStringField } from "./guards";
import { loadStore, resolveGoalPaths } from "./storage";
import type { GoalRecord, MaybeUndefined } from "./types";

interface GoalDashboardTaskSummary {
  total: number;
  complete: number;
  pending: number;
  skipped: number;
}

interface GoalDashboardGoal {
  id: string;
  objective: string;
  status: GoalRecord["status"];
  autoContinue: boolean;
  taskSummary?: GoalDashboardTaskSummary;
  pauseReason?: string;
  auditStatus?: string;
  auditMessage?: string;
}

export interface GoalDashboardState {
  focusedGoal?: GoalDashboardGoal;
  openGoals: GoalDashboardGoal[];
  archivedGoals: GoalDashboardGoal[];
  draftCount: number;
  stateDir: string;
  error?: string;
}

export interface LoadGoalDashboardStateInput {
  directory: string;
  stateDir?: string;
  sessionID?: string;
}

export function loadGoalDashboardState(input: LoadGoalDashboardStateInput): GoalDashboardState {
  const stateDir = input.stateDir ?? DEFAULT_STATE_DIR;
  try {
    const paths = resolveGoalPaths(input.directory, stateDir);
    if (fs.existsSync(paths.rootDir) === false) return emptyDashboard(stateDir);
    const store = loadStore(paths);
    return {
      focusedGoal: focusedDashboardGoal(store, input.sessionID),
      openGoals: openGoals(store).map(summarizeDashboardGoal),
      archivedGoals: store.goals.filter(isArchivedGoal).map(summarizeDashboardGoal),
      draftCount: Object.keys(store.drafts ?? {}).length,
      stateDir,
    };
  } catch (error) {
    return {
      ...emptyDashboard(stateDir),
      error: errorMessage(error),
    };
  }
}

export function renderGoalDashboardText(state: GoalDashboardState): string {
  const lines = ["Goal X Dashboard", `State dir: ${state.stateDir}`];
  if (state.error !== undefined) lines.push(`Error: ${state.error}`);
  if (state.focusedGoal !== undefined) {
    lines.push("");
    lines.push("Focused goal:");
    lines.push(renderGoalLine(state.focusedGoal));
  }
  lines.push("");
  lines.push(`Open goals (${state.openGoals.length}):`);
  if (state.openGoals.length === 0) lines.push("- none");
  for (const goal of state.openGoals) lines.push(renderGoalLine(goal));
  lines.push("");
  lines.push(`Drafts pending confirmation: ${state.draftCount}`);
  lines.push(`Archived goals: ${state.archivedGoals.length}`);
  return lines.join("\n");
}

export function renderFocusedGoalBadge(state: GoalDashboardState): string {
  if (state.error !== undefined) return "Goal X: error";
  if (state.focusedGoal === undefined) return draftBadgeText(state.draftCount);
  const goal = state.focusedGoal;
  return `Goal X: ${goal.status}${compactTaskText(goal)}${compactAuditText(goal)}`;
}

export function parseTuiStateDir(options: unknown): MaybeUndefined<string> {
  if (isRecord(options) === false) return undefined;
  const value = nonBlankStringField(options, "stateDir");
  if (value === undefined) return undefined;
  return value.trim();
}

function emptyDashboard(stateDir: string): GoalDashboardState {
  return {
    openGoals: [],
    archivedGoals: [],
    draftCount: 0,
    stateDir,
  };
}

function summarizeDashboardGoal(goal: GoalRecord): GoalDashboardGoal {
  const taskSummary = dashboardTaskSummary(goal);
  return {
    id: goal.id,
    objective: goal.objective,
    status: goal.status,
    autoContinue: goal.autoContinue,
    taskSummary,
    pauseReason: goal.pauseReason,
    auditStatus: dashboardAuditStatus(goal),
    auditMessage: dashboardAuditMessage(goal),
  };
}

function dashboardAuditStatus(goal: GoalRecord): MaybeUndefined<string> {
  if (goal.auditProgress !== undefined) return goal.auditProgress.status;
  if (goal.audit !== undefined) return goal.audit.decision;
  return undefined;
}

function dashboardAuditMessage(goal: GoalRecord): MaybeUndefined<string> {
  if (goal.auditProgress !== undefined) return goal.auditProgress.message;
  if (goal.audit !== undefined) return goal.audit.summary;
  return undefined;
}

function renderGoalLine(goal: GoalDashboardGoal): string {
  return `- ${goal.id} [${goal.status}, ${dashboardAutoText(goal)}${dashboardTaskText(goal)}${compactAuditText(goal)}] ${goal.objective}`;
}

function focusedDashboardGoal(store: ReturnType<typeof loadStore>, sessionID: MaybeUndefined<string>): MaybeUndefined<GoalDashboardGoal> {
  if (sessionID === undefined) return undefined;
  const goal = focusedGoal(store, sessionID);
  if (goal === undefined) return undefined;
  return summarizeDashboardGoal(goal);
}

function isArchivedGoal(goal: GoalRecord): boolean {
  return goal.status === "complete" || goal.status === "aborted";
}

function dashboardTaskSummary(goal: GoalRecord): MaybeUndefined<GoalDashboardTaskSummary> {
  if (goal.taskList === undefined) return undefined;
  return countTasks(goal.taskList.tasks);
}

function draftBadgeText(draftCount: number): string {
  if (draftCount > 0) return `Goal X: ${draftCount} draft`;
  return "Goal X: none";
}

function compactTaskText(goal: GoalDashboardGoal): string {
  if (goal.taskSummary === undefined) return "";
  return ` ${goal.taskSummary.complete}/${goal.taskSummary.total}`;
}

function dashboardTaskText(goal: GoalDashboardGoal): string {
  if (goal.taskSummary === undefined) return "";
  return ` tasks ${goal.taskSummary.complete}/${goal.taskSummary.total}`;
}

function dashboardAutoText(goal: GoalDashboardGoal): string {
  if (goal.autoContinue) return "auto:on";
  return "auto:off";
}

function compactAuditText(goal: GoalDashboardGoal): string {
  if (goal.auditStatus === undefined) return "";
  return ` audit:${goal.auditStatus}`;
}
