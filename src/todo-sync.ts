import { z } from "zod";
import { findTask, nowIso, updateTaskTree } from "./goal";
import type { GoalRecord, GoalTask, MaybeUndefined, OperationResult, TaskStatus } from "./types";

export const OpenCodeTodoSnapshotSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  status: z.string().min(1),
  priority: z.string().optional(),
});

const OpenCodeTodoSnapshotArraySchema = z.array(OpenCodeTodoSnapshotSchema);

export type OpenCodeTodoSnapshot = z.infer<typeof OpenCodeTodoSnapshotSchema>;

type TodoTerminalStatus = Extract<TaskStatus, "complete" | "skipped">;

interface TodoSyncUpdate {
  taskID: string;
  todoID: string;
  status: TodoTerminalStatus;
  evidence: string;
}

export interface TodoSyncResult {
  goal: GoalRecord;
  updates: TodoSyncUpdate[];
  validationError?: string;
}

export function parseOpenCodeTodoSnapshots(rawTodos: unknown): OperationResult<OpenCodeTodoSnapshot[]> {
  const parsed = OpenCodeTodoSnapshotArraySchema.safeParse(rawTodos);
  if (parsed.success === false) return { ok: false, message: "OpenCode todo payload has invalid shape." };
  return { ok: true, value: parsed.data };
}

export function syncGoalTasksFromTodos(goal: GoalRecord, rawTodos: unknown): TodoSyncResult {
  const parsedTodos = parseOpenCodeTodoSnapshots(rawTodos);
  if (parsedTodos.ok === false) return { goal, updates: [], validationError: parsedTodos.message };
  if (goal.taskList === undefined) return { goal, updates: [] };
  const todos = parsedTodos.value;
  const updates: TodoSyncUpdate[] = [];
  let tasks = goal.taskList.tasks;

  for (const todo of todos) {
    const taskID = matchTodoTaskID(goal.taskList.tasks, todo);
    if (taskID === undefined) continue;
    const task = findTask(tasks, taskID);
    if (task === undefined) continue;
    if (task.status !== "pending") continue;

    const normalizedStatus = normalizeTodoStatus(todo.status);
    if (normalizedStatus === undefined) continue;

    const evidence = `OpenCode todo ${todo.id} marked ${todo.status}: ${todo.content}`;
    updates.push({ taskID, todoID: todo.id, status: normalizedStatus, evidence });
    tasks = updateTaskTree(tasks, taskID, (current) => taskFromTodo(current, normalizedStatus, evidence));
  }

  if (updates.length === 0) return { goal, updates };
  return {
    goal: {
      ...goal,
      taskList: { ...goal.taskList, tasks },
      updatedAt: nowIso(),
    },
    updates,
  };
}

export function taskToTodoContent(task: GoalTask): string {
  return `[goal:${task.id}] ${task.title}`;
}

function taskFromTodo(task: GoalTask, status: TodoTerminalStatus, evidence: string): GoalTask {
  if (status === "complete") {
    return {
      ...task,
      status,
      evidence,
      completedAt: nowIso(),
    };
  }
  return {
    ...task,
    status,
    skipReason: evidence,
    skippedAt: nowIso(),
  };
}

function normalizeTodoStatus(status: string): MaybeUndefined<TodoTerminalStatus> {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "complete" || normalized === "done") return "complete";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "skipped") return "skipped";
  return undefined;
}

function matchTodoTaskID(tasks: GoalTask[], todo: OpenCodeTodoSnapshot): MaybeUndefined<string> {
  for (const task of tasks) {
    const match = matchSingleTask(task, todo);
    if (match !== undefined) return match;
  }
  return undefined;
}

function matchSingleTask(task: GoalTask, todo: OpenCodeTodoSnapshot): MaybeUndefined<string> {
  if (todo.id === task.id) return task.id;
  if (todo.content.includes(`[goal:${task.id}]`)) return task.id;
  if (todo.content.trim() === task.title.trim()) return task.id;
  if (task.subtasks === undefined) return undefined;
  return matchTodoTaskID(task.subtasks, todo);
}
