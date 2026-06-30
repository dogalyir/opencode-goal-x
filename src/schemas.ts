import { z } from "zod";
import { DEFAULT_OPTIONS } from "./defaults";
import type {
  AuditRecord,
  GoalBudget,
  GoalProgress,
  GoalRecord,
  GoalRuntimeOptions,
  GoalStoreSnapshot,
  GoalTask,
  GoalTaskList,
} from "./types";

const GoalStatusSchema = z.enum(["active", "paused", "complete", "aborted"]);
const GoalStopReasonSchema = z.enum(["user", "agent", "limit", "audit_rejected", "error"]);
const TaskStatusSchema = z.enum(["pending", "complete", "skipped"]);

const GoalBudgetSchema: z.ZodType<GoalBudget> = z.object({
  maxTurns: z.number().int().positive(),
  maxRuntimeMs: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  minDelayMs: z.number().int().nonnegative(),
  noProgressTurnsBeforePause: z.number().int().positive(),
  noToolCallTurnsBeforePause: z.number().int().positive(),
  noProgressTokenThreshold: z.number().int().nonnegative(),
  maxPromptFailures: z.number().int().positive(),
});

const GoalProgressSchema: z.ZodType<GoalProgress> = z.object({
  continuationTurns: z.number().int().nonnegative(),
  promptFailures: z.number().int().nonnegative(),
  noProgressTurns: z.number().int().nonnegative(),
  noToolCallTurns: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
  startedAt: z.number().int().positive(),
  lastContinuedAt: z.number().int().positive().optional(),
  lastAssistantOutputTokens: z.number().int().nonnegative().optional(),
  toolCallsSinceLastContinue: z.number().int().nonnegative(),
  latestCheckpoint: z.string().optional(),
});

const GoalTaskSchema: z.ZodType<GoalTask> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: TaskStatusSchema,
    verificationContract: z.string().min(1).optional(),
    evidence: z.string().min(1).optional(),
    skipReason: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
    skippedAt: z.string().min(1).optional(),
    subtasks: z.array(GoalTaskSchema).optional(),
  }),
);

const GoalTaskListSchema: z.ZodType<GoalTaskList> = z.object({
  tasks: z.array(GoalTaskSchema),
  blockCompletion: z.boolean(),
  proposedAt: z.string().min(1),
});

const AuditRecordSchema: z.ZodType<AuditRecord> = z.object({
  decision: z.enum(["approved", "rejected"]),
  summary: z.string(),
  auditorSessionID: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  createdAt: z.string().min(1),
});

export const GoalRecordSchema: z.ZodType<GoalRecord> = z.object({
  id: z.string().min(1),
  objective: z.string().min(1),
  status: GoalStatusSchema,
  autoContinue: z.boolean(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  sessionID: z.string().min(1).optional(),
  verificationContract: z.string().min(1).optional(),
  successCriteria: z.string().min(1).optional(),
  constraints: z.string().min(1).optional(),
  stopReason: GoalStopReasonSchema.optional(),
  pauseReason: z.string().min(1).optional(),
  abortReason: z.string().min(1).optional(),
  completionSummary: z.string().min(1).optional(),
  verificationSummary: z.string().min(1).optional(),
  activePath: z.string().min(1).optional(),
  archivedPath: z.string().min(1).optional(),
  taskList: GoalTaskListSchema.optional(),
  budget: GoalBudgetSchema,
  progress: GoalProgressSchema,
  audit: AuditRecordSchema.optional(),
});

export const GoalStoreSnapshotSchema: z.ZodType<GoalStoreSnapshot> = z.object({
  version: z.literal(1),
  goals: z.array(GoalRecordSchema),
  focusBySession: z.record(z.string(), z.string()),
  updatedAt: z.string().min(1),
});

const PluginOptionsSchema = z.object({
  commandName: z.string().min(1).optional(),
  stateDir: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  maxRuntimeMs: z.number().int().positive().optional(),
  maxMinutes: z.number().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  minDelayMs: z.number().int().nonnegative().optional(),
  noProgressTurnsBeforePause: z.number().int().positive().optional(),
  noToolCallTurnsBeforePause: z.number().int().positive().optional(),
  noProgressTokenThreshold: z.number().int().nonnegative().optional(),
  maxPromptFailures: z.number().int().positive().optional(),
  requireAudit: z.boolean().optional(),
  completionAudit: z.boolean().optional(),
  auditTimeoutMs: z.number().int().positive().optional(),
  auditorModel: z.string().min(1).optional(),
  auditorAgent: z.string().min(1).optional(),
});

export function normalizeOptions(rawOptions: unknown): GoalRuntimeOptions {
  const parsed = PluginOptionsSchema.safeParse(rawOptions);
  if (!parsed.success) return DEFAULT_OPTIONS;

  const options = parsed.data;
  const requireAudit = options.requireAudit ?? options.completionAudit ?? DEFAULT_OPTIONS.requireAudit;
  const maxRuntimeMs = options.maxRuntimeMs ?? (options.maxMinutes === undefined ? DEFAULT_OPTIONS.maxRuntimeMs : Math.round(options.maxMinutes * 60_000));

  return {
    commandName: normalizeCommandName(options.commandName ?? DEFAULT_OPTIONS.commandName),
    stateDir: options.stateDir ?? DEFAULT_OPTIONS.stateDir,
    maxTurns: options.maxTurns ?? DEFAULT_OPTIONS.maxTurns,
    maxRuntimeMs,
    maxTokens: options.maxTokens ?? DEFAULT_OPTIONS.maxTokens,
    minDelayMs: options.minDelayMs ?? DEFAULT_OPTIONS.minDelayMs,
    noProgressTurnsBeforePause: options.noProgressTurnsBeforePause ?? DEFAULT_OPTIONS.noProgressTurnsBeforePause,
    noToolCallTurnsBeforePause: options.noToolCallTurnsBeforePause ?? DEFAULT_OPTIONS.noToolCallTurnsBeforePause,
    noProgressTokenThreshold: options.noProgressTokenThreshold ?? DEFAULT_OPTIONS.noProgressTokenThreshold,
    maxPromptFailures: options.maxPromptFailures ?? DEFAULT_OPTIONS.maxPromptFailures,
    requireAudit,
    auditTimeoutMs: options.auditTimeoutMs ?? DEFAULT_OPTIONS.auditTimeoutMs,
    auditorModel: options.auditorModel,
    auditorAgent: options.auditorAgent,
  };
}

function normalizeCommandName(commandName: string): string {
  if (commandName.startsWith("/")) return commandName.slice(1);
  return commandName;
}
