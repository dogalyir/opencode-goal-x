import { cleanOptionalText } from "./goal";
import type { GoalTask, OperationResult } from "./types";

export interface TaskValidationOptions {
  maxTaskCount: number;
  maxSubtaskDepth: number;
  strictTaskContracts: boolean;
}

interface TaskTreeValidationState {
  seen: Set<string>;
  count: number;
}

export function validateTaskTree(tasks: GoalTask[], options: TaskValidationOptions): OperationResult<{ count: number }> {
  if (tasks.length === 0) return { ok: false, message: "Task list rejected: at least one task is required." };
  const state: TaskTreeValidationState = { seen: new Set<string>(), count: 0 };
  const result = validateTasks(tasks, options, state, 0);
  if (result.ok === false) return result;
  return { ok: true, value: { count: state.count } };
}

function validateTasks(
  tasks: GoalTask[],
  options: TaskValidationOptions,
  state: TaskTreeValidationState,
  depth: number,
): OperationResult<void> {
  for (const task of tasks) {
    const result = validateTask(task, options, state, depth);
    if (result.ok === false) return result;
  }
  return { ok: true, value: undefined };
}

function validateTask(
  task: GoalTask,
  options: TaskValidationOptions,
  state: TaskTreeValidationState,
  depth: number,
): OperationResult<void> {
  const id = task.id.trim();
  if (id.length === 0) return { ok: false, message: "Task list rejected: task id cannot be empty." };
  if (task.title.trim().length === 0) return { ok: false, message: `Task list rejected: task ${id} has an empty title.` };
  if (state.seen.has(id)) return { ok: false, message: `Task list rejected: duplicate task id ${id}.` };
  if (depth > options.maxSubtaskDepth) return { ok: false, message: `Task list rejected: task ${id} exceeds max subtask depth ${options.maxSubtaskDepth}.` };
  state.seen.add(id);
  state.count += 1;
  if (state.count > options.maxTaskCount) return { ok: false, message: `Task list rejected: more than ${options.maxTaskCount} tasks were provided.` };

  if (task.status === "complete") {
    const evidence = cleanOptionalText(task.evidence);
    if (evidence === undefined) return { ok: false, message: `Task list rejected: completed task ${id} requires evidence.` };
    if (options.strictTaskContracts && task.verificationContract !== undefined && evidence.length === 0) {
      return { ok: false, message: `Task list rejected: completed task ${id} must address its verification contract.` };
    }
  }

  if (task.status === "skipped") {
    const reason = cleanOptionalText(task.skipReason);
    if (reason === undefined) return { ok: false, message: `Task list rejected: skipped task ${id} requires a skip reason.` };
  }

  if (task.subtasks === undefined) return { ok: true, value: undefined };
  if (task.lightweightSubtasks && task.subtasks.length === 0) return { ok: false, message: `Task list rejected: task ${id} marks lightweight subtasks but has no subtasks.` };
  return validateTasks(task.subtasks, options, state, depth + 1);
}

export function hasPendingSubtasks(task: GoalTask): boolean {
  if (task.subtasks === undefined) return false;
  for (const subtask of task.subtasks) {
    if (subtask.status === "pending") return true;
    if (hasPendingSubtasks(subtask)) return true;
  }
  return false;
}
