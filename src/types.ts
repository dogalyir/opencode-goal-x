import type { OpencodeClient } from "@opencode-ai/sdk";

export type MaybeNull<Value> = Value | null;
export type MaybeUndefined<Value> = Value | undefined;
export type MaybeOptional<Value> = MaybeNull<MaybeUndefined<Value>>;
export type MaybeVoid = void | undefined;
export type UnknownRecord = Record<string, unknown>;
export type FocusBySessionMap = Record<string, string>;
export type ToolPermissionMap = Record<string, boolean>;

export interface TextPromptPart {
  type: "text";
  text: string;
}

export interface MutableTextPart {
  type: string;
  text?: string;
}

export interface ExecutionModel {
  providerID: string;
  modelID: string;
}

export interface TaskCounts {
  total: number;
  complete: number;
  skipped: number;
  pending: number;
}

export type GoalStatus = "active" | "paused" | "complete" | "aborted";
export type TaskStatus = "pending" | "complete" | "skipped";
type GoalStopReason = "user" | "agent" | "limit" | "audit_rejected" | "error";
type AuditDecision = "approved" | "rejected";
type AuditProgressStatus = "idle" | "starting" | "running" | "approved" | "rejected" | "error";
type GoalDraftStatus = "planning" | "proposed";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  verificationContract?: string;
  evidence?: string;
  skipReason?: string;
  completedAt?: string;
  skippedAt?: string;
  lightweightSubtasks?: boolean;
  subtasks?: GoalTask[];
}

export interface GoalTaskList {
  tasks: GoalTask[];
  blockCompletion: boolean;
  proposedAt: string;
}

export interface GoalBudget {
  maxTurns: number;
  maxRuntimeMs: number;
  maxTokens: number;
  minDelayMs: number;
  noProgressTurnsBeforePause: number;
  noToolCallTurnsBeforePause: number;
  noProgressTokenThreshold: number;
  maxPromptFailures: number;
}

export interface GoalProgress {
  continuationTurns: number;
  promptFailures: number;
  noProgressTurns: number;
  noToolCallTurns: number;
  tokensUsed: number;
  startedAt: number;
  lastContinuedAt?: number;
  lastAssistantOutputTokens?: number;
  toolCallsSinceLastContinue: number;
  latestCheckpoint?: string;
}

export interface AuditRecord {
  decision: AuditDecision;
  summary: string;
  auditorSessionID?: string;
  model?: string;
  variant?: string;
  createdAt: string;
}

export interface AuditProgressRecord {
  status: AuditProgressStatus;
  message: string;
  auditorSessionID?: string;
  updatedAt: string;
}

export interface GoalDraft {
  id: string;
  sessionID: string;
  status: GoalDraftStatus;
  topic: string;
  objective: string;
  successCriteria?: string;
  constraints?: string;
  verificationContract?: string;
  taskList?: GoalTaskList;
  budgetOverrides?: Partial<GoalBudget>;
  autoContinue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SessionExecutionContext {
  sessionID: string;
  agent?: string;
  providerID?: string;
  modelID?: string;
  variant?: string;
  lastUserMessageID?: string;
  source: "chat.message" | "message.updated" | "command.execute.before" | "compaction.autocontinue" | "tool";
  updatedAt: string;
}

export interface GoalRecord {
  id: string;
  objective: string;
  status: GoalStatus;
  autoContinue: boolean;
  createdAt: string;
  updatedAt: string;
  sessionID?: string;
  verificationContract?: string;
  successCriteria?: string;
  constraints?: string;
  stopReason?: GoalStopReason;
  pauseReason?: string;
  abortReason?: string;
  completionSummary?: string;
  verificationSummary?: string;
  activePath?: string;
  archivedPath?: string;
  taskList?: GoalTaskList;
  budget: GoalBudget;
  progress: GoalProgress;
  audit?: AuditRecord;
  auditProgress?: AuditProgressRecord;
}

export type GoalDraftMap = Record<string, GoalDraft>;
export type SessionExecutionContextMap = Record<string, SessionExecutionContext>;
export type AuditProgressMap = Record<string, AuditProgressRecord>;

export interface GoalStoreSnapshot {
  version: 1;
  goals: GoalRecord[];
  focusBySession: FocusBySessionMap;
  drafts?: GoalDraftMap;
  executionContexts?: SessionExecutionContextMap;
  auditProgress?: AuditProgressMap;
  updatedAt: string;
}

export interface GoalPaths {
  rootDir: string;
  activeDir: string;
  archiveDir: string;
  stateFile: string;
  ledgerFile: string;
}

export interface GoalRuntimeOptions extends GoalBudget {
  commandName: string;
  stateDir: string;
  planningAgent: string;
  executionAgent: string;
  requireAudit: boolean;
  auditTimeoutMs: number;
  auditorModel?: string;
  auditorAgent?: string;
  auditorVariant?: string;
  readonlyAuditor: boolean;
  todoSync: boolean;
  maxTaskCount: number;
  maxSubtaskDepth: number;
  strictTaskContracts: boolean;
}

export interface ParsedGoalCommand {
  action: ParsedGoalCommandAction;
  objective?: string;
  goalId?: string;
  reason?: string;
  successCriteria?: string;
  constraints?: string;
  verificationContract?: string;
  budgetOverrides: Partial<GoalBudget>;
}

type ParsedGoalCommandAction =
  | "draft"
  | "start"
  | "confirm"
  | "reject"
  | "status"
  | "list"
  | "focus"
  | "pause"
  | "resume"
  | "clear"
  | "abort"
  | "tweak"
  | "help";

export interface CommandExecutionResult {
  text: string;
  shouldAutoContinue: boolean;
}

export interface AuditRequest {
  client: OpencodeClient;
  directory: string;
  parentSessionID: string;
  goal: GoalRecord;
  completionSummary: string;
  verificationSummary: string;
  options: GoalRuntimeOptions;
  executionContext?: SessionExecutionContext;
  onProgress?: (message: string, auditorSessionID?: string) => void;
}

export interface AuditResult {
  approved: boolean;
  output: string;
  auditorSessionID?: string;
  model?: string;
  variant?: string;
  error?: string;
}

interface OperationSuccess<Value> {
  ok: true;
  value: Value;
}

interface OperationFailure {
  ok: false;
  message: string;
}

export type OperationResult<Value> = OperationSuccess<Value> | OperationFailure;
