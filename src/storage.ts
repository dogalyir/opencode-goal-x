import * as fs from "node:fs";
import * as path from "node:path";
import {
  ACTIVE_DIR_NAME,
  ARCHIVE_DIR_NAME,
  LEDGER_FILE_NAME,
  LOCK_DIR_NAME,
  METADATA_END,
  METADATA_START,
  STATE_FILE_NAME,
  STORE_VERSION,
} from "./defaults";
import { errorCode, errorMessage } from "./errors";
import { createEmptyStore, isOpenGoal, nowIso, safeIdPart, summarizeGoal } from "./goal";
import { GoalRecordSchema, GoalStoreSnapshotSchema, UnknownRecordSchema } from "./schemas";
import { renderTaskTree } from "./task-render";
import { nonEmptyTrimmedText } from "./text";
import type { GoalPaths, GoalRecord, GoalStoreSnapshot, MaybeUndefined, OperationResult, UnknownRecord } from "./types";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 5_000;

type GoalMarkdownLocation = "active" | "archive";
type SchemaParseResult<Value> = { success: true; data: Value } | { success: false };
type JsonFileParser<Value> = (value: unknown) => SchemaParseResult<Value>;

export function resolveGoalPaths(directory: string, stateDir: string): GoalPaths {
  validateRelativeStateDir(stateDir);
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
  if (stateResult.ok) return reconcileStoreWithMarkdown(paths, normalizeStore(stateResult.value));

  const recoveredGoals = readGoalMarkdownDirectory(paths.activeDir, "active").concat(readGoalMarkdownDirectory(paths.archiveDir, "archive"));
  if (recoveredGoals.length === 0) return createEmptyStore();
  return normalizeStore({
    version: STORE_VERSION,
    goals: recoveredGoals,
    focusBySession: {},
    updatedAt: nowIso(),
  });
}

export function saveStore(paths: GoalPaths, store: GoalStoreSnapshot): void {
  ensureGoalDirectories(paths);
  withGoalWriteLock(paths, () => {
    const snapshot = normalizeStore({ ...store, updatedAt: nowIso() });
    atomicWriteFile(paths.stateFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  });
}

export function appendLedger(paths: GoalPaths, event: UnknownRecord): void {
  ensureGoalDirectories(paths);
  withGoalWriteLock(paths, () => {
    const line = JSON.stringify({ ...event, at: nowIso() });
    fs.appendFileSync(paths.ledgerFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(paths.ledgerFile, 0o600);
  });
}

export function readLedgerEvents(paths: GoalPaths, limit: number): UnknownRecord[] {
  ensureGoalDirectories(paths);
  const contentResult = readUtf8File(paths.ledgerFile, "ledger file");
  if (contentResult.ok === false) return [];
  const lines = contentResult.value.split("\n").filter((line) => line.trim().length > 0);
  const start = Math.max(0, lines.length - limit);
  const events: UnknownRecord[] = [];
  for (const line of lines.slice(start)) {
    const parsed = parseJsonValue(line);
    if (parsed.ok === false) continue;
    const ledgerEvent = UnknownRecordSchema.safeParse(parsed.value);
    if (ledgerEvent.success === false) continue;
    events.push(ledgerEvent.data);
  }
  return events;
}

export function writeGoalMarkdown(paths: GoalPaths, goal: GoalRecord): GoalRecord {
  ensureGoalDirectories(paths);
  return withGoalWriteLock(paths, () => {
    if (goal.status === "complete" || goal.status === "aborted") return writeArchivedGoalMarkdownUnlocked(paths, goal);
    const fallbackPath = path.join(paths.activeDir, `active_goal_${safeFilename(goal)}.md`);
    const activePath = safeManagedPath(paths.activeDir, goal.activePath, fallbackPath);
    const next = { ...goal, activePath, archivedPath: undefined };
    atomicWriteFile(activePath, serializeGoalMarkdown(next));
    return next;
  });
}

function writeArchivedGoalMarkdownUnlocked(paths: GoalPaths, goal: GoalRecord): GoalRecord {
  const fallbackPath = path.join(paths.archiveDir, `goal_${safeFilename(goal)}.md`);
  const archivedPath = safeManagedPath(paths.archiveDir, goal.archivedPath, fallbackPath);
  const next = { ...goal, archivedPath, activePath: undefined };
  atomicWriteFile(archivedPath, serializeGoalMarkdown(next));
  if (goal.activePath !== undefined) unlinkIfSafe(paths.activeDir, goal.activePath);
  return next;
}

function unlinkIfSafe(rootDir: string, filePath: string): void {
  const resolvedFile = managedPathInside(rootDir, filePath);
  if (resolvedFile === undefined) return;
  if (fs.existsSync(resolvedFile) === false) return;
  const stats = fs.lstatSync(resolvedFile);
  if (stats.isSymbolicLink()) return;
  fs.unlinkSync(resolvedFile);
}

function reconcileStoreWithMarkdown(paths: GoalPaths, store: GoalStoreSnapshot): GoalStoreSnapshot {
  const markdownGoals = readGoalMarkdownDirectory(paths.activeDir, "active").concat(readGoalMarkdownDirectory(paths.archiveDir, "archive"));
  const markdownByID = new Map<string, GoalRecord>();
  for (const markdownGoal of markdownGoals) markdownByID.set(markdownGoal.id, markdownGoal);

  const goals: GoalRecord[] = [];
  const seen = new Set<string>();
  for (const current of store.goals) {
    const markdownGoal = markdownByID.get(current.id);
    if (markdownGoal !== undefined) {
      goals.push(markdownGoal);
      seen.add(markdownGoal.id);
      continue;
    }
    if (hasManagedMarkdownPath(paths, current)) continue;
    goals.push(current);
  }

  for (const markdownGoal of markdownGoals) {
    if (seen.has(markdownGoal.id)) continue;
    goals.push(markdownGoal);
  }

  const openGoalIDs = new Set(goals.filter(isOpenGoal).map((goal) => goal.id));
  const focusBySession: Record<string, string> = {};
  for (const [sessionID, goalID] of Object.entries(store.focusBySession)) {
    if (openGoalIDs.has(goalID) === false) continue;
    focusBySession[sessionID] = goalID;
  }

  return normalizeStore({ ...store, goals, focusBySession, updatedAt: nowIso() });
}

function readGoalMarkdownDirectory(directoryPath: string, location: GoalMarkdownLocation): GoalRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(directoryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw new Error(`Could not read goal directory ${directoryPath}: ${errorMessage(error)}`);
  }

  const goals: GoalRecord[] = [];
  for (const entry of entries) {
    if (entry.endsWith(".md") === false) continue;
    const goalPath = path.join(directoryPath, entry);
    const goal = readGoalMarkdown(goalPath, location);
    if (goal === undefined) continue;
    goals.push(goal);
  }
  return goals;
}

function readGoalMarkdown(goalPath: string, location: GoalMarkdownLocation): MaybeUndefined<GoalRecord> {
  const contentResult = readUtf8File(goalPath, "goal markdown");
  if (contentResult.ok === false) return undefined;
  const content = contentResult.value;

  const metadata = extractMetadata(content);
  if (metadata.ok === false) return undefined;
  const parsed = GoalRecordSchema.safeParse(metadata.value);
  if (parsed.success === false) return undefined;
  const objective = extractGoalPrompt(content) ?? parsed.data.objective;
  return goalFromMarkdownLocation({ ...parsed.data, objective }, goalPath, location);
}

function goalFromMarkdownLocation(goal: GoalRecord, goalPath: string, location: GoalMarkdownLocation): GoalRecord {
  if (location === "archive") return archivedGoalFromMarkdown(goal, goalPath);
  if (goal.status === "active" || goal.status === "paused") {
    return { ...goal, activePath: goalPath, archivedPath: undefined };
  }
  return { ...goal, activePath: undefined, archivedPath: goalPath, autoContinue: false };
}

function archivedGoalFromMarkdown(goal: GoalRecord, goalPath: string): GoalRecord {
  if (goal.status === "complete" || goal.status === "aborted") {
    return { ...goal, activePath: undefined, archivedPath: goalPath, autoContinue: false };
  }
  return {
    ...goal,
    status: "aborted",
    autoContinue: false,
    stopReason: "user",
    pauseReason: undefined,
    abortReason: goal.abortReason ?? "Archived externally on disk.",
    activePath: undefined,
    archivedPath: goalPath,
    updatedAt: nowIso(),
  };
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

function extractGoalPrompt(content: string): MaybeUndefined<string> {
  const marker = "# Goal Prompt";
  const start = content.indexOf(marker);
  if (start < 0) return undefined;
  const bodyStart = start + marker.length;
  const nextSection = content.indexOf("\n## ", bodyStart);
  const raw = nextSection < 0 ? content.slice(bodyStart) : content.slice(bodyStart, nextSection);
  return nonEmptyTrimmedText(raw);
}

function readJsonFile<Value>(filePath: string, parse: JsonFileParser<Value>): OperationResult<Value> {
  const contentResult = readUtf8File(filePath, "state file");
  if (contentResult.ok === false) return contentResult;
  const content = contentResult.value;

  const jsonResult = parseJsonValue(content);
  if (jsonResult.ok === false) return jsonResult;
  const raw = jsonResult.value;
  const parsed = parse(raw);
  if (parsed.success === false) return { ok: false, message: "invalid state shape" };
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

function validateRelativeStateDir(stateDir: string): void {
  if (stateDir.includes("\0")) throw new Error("Goal stateDir cannot contain NUL bytes.");
  if (path.isAbsolute(stateDir)) throw new Error("Goal stateDir must be relative to the project directory.");
  const normalized = path.normalize(stateDir);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("Goal stateDir cannot traverse outside the project directory.");
}

function safeManagedPath(rootDir: string, candidate: MaybeUndefined<string>, fallbackPath: string): string {
  if (candidate === undefined) return fallbackPath;
  if (candidate.includes("\0")) throw new Error("Goal path cannot contain NUL bytes.");
  const resolvedCandidate = managedPathInside(rootDir, candidate);
  if (resolvedCandidate === undefined) return fallbackPath;
  if (fs.existsSync(resolvedCandidate) === false) return resolvedCandidate;
  const stats = fs.lstatSync(resolvedCandidate);
  if (stats.isSymbolicLink()) throw new Error(`Refusing to write symlinked goal file: ${resolvedCandidate}`);
  return resolvedCandidate;
}

function hasManagedMarkdownPath(paths: GoalPaths, goal: GoalRecord): boolean {
  if (goal.activePath !== undefined && isPathInside(paths.activeDir, goal.activePath)) return true;
  if (goal.archivedPath !== undefined && isPathInside(paths.archiveDir, goal.archivedPath)) return true;
  return false;
}

function isPathInside(rootDir: string, filePath: string): boolean {
  return managedPathInside(rootDir, filePath) !== undefined;
}

function managedPathInside(rootDir: string, filePath: string): MaybeUndefined<string> {
  if (filePath.includes("\0")) return undefined;
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  if (path.isAbsolute(relative)) return undefined;
  return resolvedFile;
}

function normalizeStore(store: GoalStoreSnapshot): GoalStoreSnapshot {
  return {
    ...store,
    drafts: store.drafts ?? {},
    executionContexts: store.executionContexts ?? {},
    auditProgress: store.auditProgress ?? {},
  };
}

function withGoalWriteLock<Value>(paths: GoalPaths, write: () => Value): Value {
  const lockDir = path.join(paths.rootDir, LOCK_DIR_NAME);
  const start = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      clearStaleLock(lockDir);
      if (Date.now() - start > LOCK_MAX_WAIT_MS) throw new Error(`Timed out waiting for goal state lock: ${lockDir}`);
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return write();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function clearStaleLock(lockDir: string): void {
  try {
    const stats = fs.statSync(lockDir);
    if (Date.now() - stats.mtimeMs < LOCK_STALE_MS) return;
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
}

function sleepSync(ms: number): void {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
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

function serializeTasks(goal: GoalRecord): MaybeUndefined<string> {
  if (goal.taskList === undefined) return undefined;
  const lines = ["## Tasks", ""];
  lines.push(...renderTaskTree(goal.taskList.tasks, { mode: "markdown", includeEvidenceLines: false }));
  return lines.join("\n");
}
