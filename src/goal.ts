import { randomUUID } from "node:crypto";
import { DEFAULT_BUDGET } from "./defaults";
import { appendGoalContractLines } from "./goal-details";
import { nonEmptyTrimmedText } from "./text";
import type { GoalBudget, GoalRecord, GoalStatus, GoalStoreSnapshot, GoalTask } from "./types";

export function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

export function safeIdPart(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  if (safe.length === 0) return "goal";
  return safe;
}

export function createEmptyStore(now = Date.now()): GoalStoreSnapshot {
  return {
    version: 1,
    goals: [],
    focusBySession: {},
    updatedAt: nowIso(now),
  };
}

export function createGoal(input: {
  objective: string;
  sessionID: string;
  autoContinue: boolean;
  budgetOverrides?: Partial<GoalBudget>;
  successCriteria?: string;
  constraints?: string;
  verificationContract?: string;
  now?: number;
}): GoalRecord {
  const createdAtMs = input.now ?? Date.now();
  const createdAt = nowIso(createdAtMs);
  const budget = mergeBudget(input.budgetOverrides);
  return {
    id: randomUUID(),
    objective: input.objective.trim(),
    status: "active",
    autoContinue: input.autoContinue,
    createdAt,
    updatedAt: createdAt,
    sessionID: input.sessionID,
    successCriteria: cleanOptionalText(input.successCriteria),
    constraints: cleanOptionalText(input.constraints),
    verificationContract: cleanOptionalText(input.verificationContract),
    budget,
    progress: {
      continuationTurns: 0,
      promptFailures: 0,
      noProgressTurns: 0,
      noToolCallTurns: 0,
      tokensUsed: 0,
      startedAt: createdAtMs,
      toolCallsSinceLastContinue: 0,
    },
  };
}

function mergeBudget(overrides?: Partial<GoalBudget>): GoalBudget {
  if (overrides === undefined) return { ...DEFAULT_BUDGET };
  return {
    maxTurns: overrides.maxTurns ?? DEFAULT_BUDGET.maxTurns,
    maxRuntimeMs: overrides.maxRuntimeMs ?? DEFAULT_BUDGET.maxRuntimeMs,
    maxTokens: overrides.maxTokens ?? DEFAULT_BUDGET.maxTokens,
    minDelayMs: overrides.minDelayMs ?? DEFAULT_BUDGET.minDelayMs,
    noProgressTurnsBeforePause: overrides.noProgressTurnsBeforePause ?? DEFAULT_BUDGET.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause: overrides.noToolCallTurnsBeforePause ?? DEFAULT_BUDGET.noToolCallTurnsBeforePause,
    noProgressTokenThreshold: overrides.noProgressTokenThreshold ?? DEFAULT_BUDGET.noProgressTokenThreshold,
    maxPromptFailures: overrides.maxPromptFailures ?? DEFAULT_BUDGET.maxPromptFailures,
  };
}

export function cleanOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyTrimmedText(value);
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
  return {
    ...goal,
    budget: { ...goal.budget },
    progress: { ...goal.progress },
    taskList: goal.taskList === undefined
      ? undefined
      : {
          ...goal.taskList,
          tasks: goal.taskList.tasks.map(cloneTask),
        },
    audit: goal.audit === undefined ? undefined : { ...goal.audit },
  };
}

function cloneTask(task: GoalTask): GoalTask {
  return {
    ...task,
    subtasks: task.subtasks === undefined ? undefined : task.subtasks.map(cloneTask),
  };
}

export function focusGoal(store: GoalStoreSnapshot, sessionID: string, goalID: string | undefined): GoalStoreSnapshot {
  const focusBySession = { ...store.focusBySession };
  if (goalID === undefined) {
    delete focusBySession[sessionID];
  } else {
    focusBySession[sessionID] = goalID;
  }
  return { ...store, focusBySession, updatedAt: nowIso() };
}

export function upsertGoal(store: GoalStoreSnapshot, goal: GoalRecord): GoalStoreSnapshot {
  const goals: GoalRecord[] = [];
  let replaced = false;
  for (const current of store.goals) {
    if (current.id === goal.id) {
      goals.push(cloneGoal(goal));
      replaced = true;
      continue;
    }
    goals.push(cloneGoal(current));
  }
  if (!replaced) goals.push(cloneGoal(goal));
  return { ...store, goals, updatedAt: nowIso() };
}

export function focusedGoal(store: GoalStoreSnapshot, sessionID: string): GoalRecord | undefined {
  const goalID = store.focusBySession[sessionID];
  if (goalID === undefined) return undefined;
  return store.goals.find((goal) => goal.id === goalID && isOpenGoal(goal));
}

export function openGoals(store: GoalStoreSnapshot): GoalRecord[] {
  return store.goals.filter(isOpenGoal).map(cloneGoal);
}

function isOpenGoal(goal: GoalRecord): boolean {
  return goal.status === "active" || goal.status === "paused";
}

function statusLabel(status: GoalStatus): string {
  if (status === "active") return "active";
  if (status === "paused") return "paused";
  if (status === "complete") return "complete";
  return "aborted";
}

export function updateGoalStatus(goal: GoalRecord, status: GoalStatus, updates?: Partial<GoalRecord>): GoalRecord {
  return {
    ...cloneGoal(goal),
    ...updates,
    status,
    updatedAt: nowIso(),
  };
}

export function summarizeGoal(goal: GoalRecord): string {
  const lines = [
    `Goal: ${goal.objective}`,
    `Status: ${statusLabel(goal.status)}`,
    `Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
    `Turns: ${goal.progress.continuationTurns}/${goal.budget.maxTurns}`,
    `Tokens tracked: ${goal.progress.tokensUsed}/${goal.budget.maxTokens}`,
  ];
  appendGoalContractLines(lines, goal, false);
  if (goal.pauseReason !== undefined) lines.push(`Pause reason: ${goal.pauseReason}`);
  if (goal.abortReason !== undefined) lines.push(`Abort reason: ${goal.abortReason}`);
  if (goal.completionSummary !== undefined) lines.push(`Completion: ${goal.completionSummary}`);
  if (goal.verificationSummary !== undefined) lines.push(`Verification: ${goal.verificationSummary}`);
  if (goal.audit !== undefined) lines.push(`Audit: ${goal.audit.decision} (${goal.audit.createdAt})`);
  if (goal.activePath !== undefined) lines.push(`File: ${goal.activePath}`);
  if (goal.archivedPath !== undefined) lines.push(`Archive: ${goal.archivedPath}`);
  const taskLine = taskSummary(goal);
  if (taskLine !== undefined) lines.push(taskLine);
  return lines.join("\n");
}

function taskSummary(goal: GoalRecord): string | undefined {
  if (goal.taskList === undefined) return undefined;
  const counts = countTasks(goal.taskList.tasks);
  return `Tasks: ${counts.complete}/${counts.total} complete${counts.skipped > 0 ? `, ${counts.skipped} skipped` : ""}`;
}

export function countTasks(tasks: GoalTask[]): { total: number; complete: number; skipped: number; pending: number } {
  let total = 0;
  let complete = 0;
  let skipped = 0;
  for (const task of tasks) {
    total += 1;
    if (task.status === "complete") complete += 1;
    if (task.status === "skipped") skipped += 1;
    if (task.subtasks !== undefined) {
      const childCounts = countTasks(task.subtasks);
      total += childCounts.total;
      complete += childCounts.complete;
      skipped += childCounts.skipped;
    }
  }
  return { total, complete, skipped, pending: total - complete - skipped };
}

export function findTask(tasks: GoalTask[], taskID: string): GoalTask | undefined {
  for (const task of tasks) {
    if (task.id === taskID) return task;
    if (task.subtasks === undefined) continue;
    const child = findTask(task.subtasks, taskID);
    if (child !== undefined) return child;
  }
  return undefined;
}

export function updateTaskTree(tasks: GoalTask[], taskID: string, updater: (task: GoalTask) => GoalTask): GoalTask[] {
  return tasks.map((task) => {
    if (task.id === taskID) return updater(cloneTask(task));
    if (task.subtasks === undefined) return cloneTask(task);
    return { ...cloneTask(task), subtasks: updateTaskTree(task.subtasks, taskID, updater) };
  });
}

export function hasPendingBlockingTasks(goal: GoalRecord): boolean {
  if (goal.taskList === undefined) return false;
  if (!goal.taskList.blockCompletion) return false;
  const counts = countTasks(goal.taskList.tasks);
  return counts.pending > 0;
}

export function formatGoalList(store: GoalStoreSnapshot, sessionID: string): string {
  const goals = openGoals(store);
  if (goals.length === 0) return "No open goals.";
  const focusedID = store.focusBySession[sessionID];
  const lines = ["Open goals:"];
  for (let index = 0; index < goals.length; index += 1) {
    const goal = goals[index];
    if (goal === undefined) continue;
    const marker = goal.id === focusedID ? "*" : " ";
    lines.push(`${marker} ${index + 1}. ${goal.id} [${goal.status}] ${goal.objective}`);
  }
  return lines.join("\n");
}
