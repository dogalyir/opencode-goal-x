import { booleanField, isRecord, nonBlankStringField } from "./guards";
import type { GoalTask, MaybeUndefined, OperationResult, TaskStatus, UnknownRecord } from "./types";

export function normalizeToolTaskList(rawTasks: unknown[]): OperationResult<GoalTask[]> {
  const tasks: GoalTask[] = [];
  for (const rawTask of rawTasks) {
    const parsed = normalizeToolTask(rawTask);
    if (parsed.ok === false) return parsed;
    tasks.push(parsed.value);
  }
  return { ok: true, value: tasks };
}

function normalizeToolTask(rawTask: unknown): OperationResult<GoalTask> {
  if (isRecord(rawTask) === false) return { ok: false, message: "Task list rejected: task must be an object." };
  const id = nonBlankStringField(rawTask, "id");
  if (id === undefined) return { ok: false, message: "Task list rejected: task id is required." };
  const title = nonBlankStringField(rawTask, "title");
  if (title === undefined) return { ok: false, message: `Task list rejected: task ${id} title is required.` };
  const status = taskStatusField(rawTask);
  if (status === undefined) return { ok: false, message: `Task list rejected: task ${id} has invalid status.` };

  const subtasksResult = normalizeOptionalSubtasks(rawTask.subtasks);
  if (subtasksResult.ok === false) return subtasksResult;

  return {
    ok: true,
    value: {
      id,
      title,
      status,
      verificationContract: nonBlankStringField(rawTask, "verificationContract"),
      evidence: nonBlankStringField(rawTask, "evidence"),
      skipReason: nonBlankStringField(rawTask, "skipReason"),
      completedAt: nonBlankStringField(rawTask, "completedAt"),
      skippedAt: nonBlankStringField(rawTask, "skippedAt"),
      lightweightSubtasks: booleanField(rawTask, "lightweightSubtasks"),
      subtasks: subtasksResult.value,
    },
  };
}

function normalizeOptionalSubtasks(rawSubtasks: unknown): OperationResult<MaybeUndefined<GoalTask[]>> {
  if (rawSubtasks === undefined) return { ok: true, value: undefined };
  if (Array.isArray(rawSubtasks) === false) return { ok: false, message: "Task list rejected: subtasks must be an array." };
  return normalizeToolTaskList(rawSubtasks);
}

function taskStatusField(record: UnknownRecord): MaybeUndefined<TaskStatus> {
  const value = record.status;
  if (value === undefined) return "pending";
  if (value === "pending" || value === "complete" || value === "skipped") return value;
  return undefined;
}
