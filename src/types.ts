import type { OpencodeClient } from "@opencode-ai/sdk";

export type GoalStatus = "active" | "paused" | "complete" | "aborted";
type TaskStatus = "pending" | "complete" | "skipped";
type GoalStopReason = "user" | "agent" | "limit" | "audit_rejected" | "error";
type AuditDecision = "approved" | "rejected";

export interface GoalTask {
  id: string;
  title: string;
  status: TaskStatus;
  verificationContract?: string;
  evidence?: string;
  skipReason?: string;
  completedAt?: string;
  skippedAt?: string;
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
  createdAt: string;
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
}

export interface GoalStoreSnapshot {
  version: 1;
  goals: GoalRecord[];
  focusBySession: Record<string, string>;
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
  requireAudit: boolean;
  auditTimeoutMs: number;
  auditorModel?: string;
  auditorAgent?: string;
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
  | "start"
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
}

export interface AuditResult {
  approved: boolean;
  output: string;
  auditorSessionID?: string;
  model?: string;
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
