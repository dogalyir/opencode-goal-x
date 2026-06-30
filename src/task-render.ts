import type { GoalTask } from "./types";

type TaskRenderMode = "prompt" | "markdown";

export interface TaskRenderOptions {
  mode: TaskRenderMode;
  includeEvidenceLines: boolean;
}

export function renderTaskTree(tasks: GoalTask[], options: TaskRenderOptions, depth = 0): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(depth);
  for (const task of tasks) {
    lines.push(renderTaskLine(task, prefix, options.mode));
    if (task.verificationContract !== undefined) lines.push(`${prefix}  contract: ${task.verificationContract}`);
    if (options.includeEvidenceLines && task.evidence !== undefined) lines.push(`${prefix}  evidence: ${task.evidence}`);
    if (options.includeEvidenceLines && task.skipReason !== undefined) lines.push(`${prefix}  skipped: ${task.skipReason}`);
    if (task.subtasks !== undefined) lines.push(...renderTaskTree(task.subtasks, options, depth + 1));
  }
  return lines;
}

function renderTaskLine(task: GoalTask, prefix: string, mode: TaskRenderMode): string {
  const marker = taskMarker(task, mode);
  if (mode === "prompt") return `${prefix}${marker} ${task.id}: ${task.title}`;
  return `${prefix}- [${marker}] ${task.id}: ${task.title}${markdownTaskSuffix(task)}`;
}

function taskMarker(task: GoalTask, mode: TaskRenderMode): string {
  if (task.status === "complete") return mode === "prompt" ? "[x]" : "x";
  if (task.status === "skipped") return mode === "prompt" ? "[~]" : "~";
  return mode === "prompt" ? "[ ]" : " ";
}

function markdownTaskSuffix(task: GoalTask): string {
  if (task.evidence !== undefined) return ` - evidence: ${task.evidence}`;
  if (task.skipReason !== undefined) return ` - skipped: ${task.skipReason}`;
  return "";
}
