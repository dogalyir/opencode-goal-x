import * as fs from "node:fs";
import * as path from "node:path";
import {
  ACTIVE_DIR_NAME,
  ARCHIVE_DIR_NAME,
  LEDGER_FILE_NAME,
  METADATA_END,
  METADATA_START,
  STATE_FILE_NAME,
  STORE_VERSION,
} from "./defaults";
import { errorCode, errorMessage } from "./errors";
import { createEmptyStore, nowIso, safeIdPart, summarizeGoal } from "./goal";
import { GoalRecordSchema, GoalStoreSnapshotSchema } from "./schemas";
import { renderTaskTree } from "./task-render";
import { nonEmptyTrimmedText } from "./text";
import type { GoalPaths, GoalRecord, GoalStoreSnapshot, OperationResult } from "./types";

export function resolveGoalPaths(directory: string, stateDir: string): GoalPaths {
  const rootDir = path.resolve(directory, stateDir);
  return {
    rootDir,
    activeDir: path.join(rootDir, ACTIVE_DIR_NAME),
    archiveDir: path.join(rootDir, ARCHIVE_DIR_NAME),
    stateFile: path.join(rootDir, STATE_FILE_NAME),
    ledgerFile: path.join(rootDir, LEDGER_FILE_NAME),
  };
}

function ensureGoalDirectories(paths: GoalPaths): void {
  ensureDirectory(paths.rootDir);
  ensureDirectory(paths.activeDir);
  ensureDirectory(paths.archiveDir);
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directoryPath);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to use symlinked goal directory: ${directoryPath}`);
}

export function loadStore(paths: GoalPaths): GoalStoreSnapshot {
  ensureGoalDirectories(paths);
  const stateResult = readJsonFile(paths.stateFile, GoalStoreSnapshotSchema.safeParse);
  if (stateResult.ok) return reconcileStoreWithMarkdown(paths, stateResult.value);

  const recoveredGoals = readGoalMarkdownDirectory(paths.activeDir).concat(readGoalMarkdownDirectory(paths.archiveDir));
  if (recoveredGoals.length === 0) return createEmptyStore();
  return {
    version: STORE_VERSION,
    goals: recoveredGoals,
    focusBySession: {},
    updatedAt: nowIso(),
  };
}

export function saveStore(paths: GoalPaths, store: GoalStoreSnapshot): void {
  ensureGoalDirectories(paths);
  const snapshot: GoalStoreSnapshot = { ...store, updatedAt: nowIso() };
  atomicWriteFile(paths.stateFile, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export function appendLedger(paths: GoalPaths, event: Record<string, unknown>): void {
  ensureGoalDirectories(paths);
  const line = JSON.stringify({ ...event, at: nowIso() });
  fs.appendFileSync(paths.ledgerFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(paths.ledgerFile, 0o600);
}

export function writeGoalMarkdown(paths: GoalPaths, goal: GoalRecord): GoalRecord {
  ensureGoalDirectories(paths);
  if (goal.status === "complete" || goal.status === "aborted") return writeArchivedGoalMarkdown(paths, goal);
  const activePath = goal.activePath ?? path.join(paths.activeDir, `active_goal_${safeFilename(goal)}.md`);
  const next = { ...goal, activePath, archivedPath: undefined };
  atomicWriteFile(activePath, serializeGoalMarkdown(next));
  return next;
}

function writeArchivedGoalMarkdown(paths: GoalPaths, goal: GoalRecord): GoalRecord {
  ensureGoalDirectories(paths);
  const archivedPath = goal.archivedPath ?? path.join(paths.archiveDir, `goal_${safeFilename(goal)}.md`);
  const next = { ...goal, archivedPath, activePath: undefined };
  atomicWriteFile(archivedPath, serializeGoalMarkdown(next));
  if (goal.activePath !== undefined) unlinkIfSafe(paths.activeDir, goal.activePath);
  return next;
}

function unlinkIfSafe(rootDir: string, filePath: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith("..")) return;
  if (path.isAbsolute(relative)) return;
  if (!fs.existsSync(resolvedFile)) return;
  const stats = fs.lstatSync(resolvedFile);
  if (stats.isSymbolicLink()) return;
  fs.unlinkSync(resolvedFile);
}

function reconcileStoreWithMarkdown(paths: GoalPaths, store: GoalStoreSnapshot): GoalStoreSnapshot {
  const markdownGoals = readGoalMarkdownDirectory(paths.activeDir).concat(readGoalMarkdownDirectory(paths.archiveDir));
  if (markdownGoals.length === 0) return store;
  const goals = [...store.goals];
  for (const markdownGoal of markdownGoals) {
    const index = goals.findIndex((goal) => goal.id === markdownGoal.id);
    if (index < 0) {
      goals.push(markdownGoal);
      continue;
    }
    const current = goals[index];
    if (current === undefined) continue;
    goals[index] = {
      ...current,
      objective: markdownGoal.objective,
      activePath: markdownGoal.activePath ?? current.activePath,
      archivedPath: markdownGoal.archivedPath ?? current.archivedPath,
    };
  }
  return { ...store, goals, updatedAt: nowIso() };
}

function readGoalMarkdownDirectory(directoryPath: string): GoalRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw new Error(`Could not read goal directory ${directoryPath}: ${errorMessage(error)}`);
  }

  const goals: GoalRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const goalPath = path.join(directoryPath, entry);
    const goal = readGoalMarkdown(goalPath);
    if (goal === undefined) continue;
    goals.push(goal);
  }
  return goals;
}

function readGoalMarkdown(goalPath: string): GoalRecord | undefined {
  const contentResult = readUtf8File(goalPath, "goal markdown");
  if (!contentResult.ok) return undefined;
  const content = contentResult.value;

  const metadata = extractMetadata(content);
  if (!metadata.ok) return undefined;
  const parsed = GoalRecordSchema.safeParse(metadata.value);
  if (!parsed.success) return undefined;
  const objective = extractGoalPrompt(content) ?? parsed.data.objective;
  return { ...parsed.data, objective, activePath: parsed.data.status === "active" || parsed.data.status === "paused" ? goalPath : undefined, archivedPath: parsed.data.status === "complete" || parsed.data.status === "aborted" ? goalPath : undefined };
}

function extractMetadata(content: string): OperationResult<unknown> {
  const start = content.indexOf(METADATA_START);
  if (start < 0) return { ok: false, message: "metadata start not found" };
  const bodyStart = start + METADATA_START.length;
  const end = content.indexOf(METADATA_END, bodyStart);
  if (end < 0) return { ok: false, message: "metadata end not found" };
  const jsonText = content.slice(bodyStart, end).trim();
  return parseJsonValue(jsonText);
}

function extractGoalPrompt(content: string): string | undefined {
  const marker = "# Goal Prompt";
  const start = content.indexOf(marker);
  if (start < 0) return undefined;
  const bodyStart = start + marker.length;
  const nextSection = content.indexOf("\n## ", bodyStart);
  const raw = nextSection < 0 ? content.slice(bodyStart) : content.slice(bodyStart, nextSection);
  return nonEmptyTrimmedText(raw);
}

function readJsonFile<Value>(filePath: string, parse: (value: unknown) => { success: true; data: Value } | { success: false }): OperationResult<Value> {
  const contentResult = readUtf8File(filePath, "state file");
  if (!contentResult.ok) return contentResult;
  const content = contentResult.value;

  const jsonResult = parseJsonValue(content);
  if (!jsonResult.ok) return jsonResult;
  const raw = jsonResult.value;
  const parsed = parse(raw);
  if (!parsed.success) return { ok: false, message: "invalid state shape" };
  return { ok: true, value: parsed.data };
}

function atomicWriteFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) throw new Error(`Refusing to write symlinked file: ${filePath}`);
  }
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readUtf8File(filePath: string, label: string): OperationResult<string> {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) return { ok: false, message: `${label} is a symlink` };
    return { ok: true, value: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { ok: false, message: `${label} not found` };
    throw new Error(`Could not read ${label} ${filePath}: ${errorMessage(error)}`);
  }
}

function parseJsonValue(jsonText: string): OperationResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(jsonText) };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function safeFilename(goal: GoalRecord): string {
  const timestamp = goal.createdAt.replace(/[^0-9]/g, "").slice(0, 16);
  return `${timestamp}_${safeIdPart(goal.id)}`;
}

function serializeGoalMarkdown(goal: GoalRecord): string {
  return [
    METADATA_START,
    JSON.stringify(goal, null, 2),
    METADATA_END,
    "",
    "# Goal Prompt",
    "",
    goal.objective.trim(),
    "",
    "## Status",
    "",
    summarizeGoal(goal),
    "",
    serializeTasks(goal),
  ].filter((line) => line !== undefined).join("\n");
}

function serializeTasks(goal: GoalRecord): string | undefined {
  if (goal.taskList === undefined) return undefined;
  const lines = ["## Tasks", ""];
  lines.push(...renderTaskTree(goal.taskList.tasks, { mode: "markdown", includeEvidenceLines: false }));
  return lines.join("\n");
}
