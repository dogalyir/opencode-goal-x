import { z } from "zod";
import { DEFAULT_OPTIONS } from "./defaults";
import type {
  AuditRecord,
  GoalBudget,
  GoalProgress,
  AuditProgressRecord,
  GoalDraft,
  GoalRecord,
  GoalRuntimeOptions,
  GoalStoreSnapshot,
  GoalTask,
  GoalTaskList,
  SessionExecutionContext,
} from "./types";

const MS_PER_MINUTE = 60_000;

const GoalStatusSchema = z.enum(["active", "paused", "complete", "aborted"]);
const GoalStopReasonSchema = z.enum(["user", "agent", "limit", "audit_rejected", "error"]);
const TaskStatusSchema = z.enum(["pending", "complete", "skipped"]);
const AuditProgressStatusSchema = z.enum(["idle", "starting", "running", "approved", "rejected", "error"]);
const ExecutionContextSourceSchema = z.enum(["chat.message", "message.updated", "command.execute.before", "compaction.autocontinue", "tool"]);
const GoalDraftStatusSchema = z.enum(["planning", "proposed"]);
const NonEmptyStringSchema = z.string().min(1);
const OptionalNonEmptyStringSchema = NonEmptyStringSchema.optional();

export const UnknownRecordSchema = z.record(z.string(), z.unknown());

const GoalBudgetObjectSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxRuntimeMs: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  minDelayMs: z.number().int().nonnegative(),
  noProgressTurnsBeforePause: z.number().int().positive(),
  noToolCallTurnsBeforePause: z.number().int().positive(),
  noProgressTokenThreshold: z.number().int().nonnegative(),
  maxPromptFailures: z.number().int().positive(),
});

const GoalBudgetSchema: z.ZodType<GoalBudget> = GoalBudgetObjectSchema;

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
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    status: TaskStatusSchema,
    verificationContract: OptionalNonEmptyStringSchema,
    evidence: OptionalNonEmptyStringSchema,
    skipReason: OptionalNonEmptyStringSchema,
    completedAt: OptionalNonEmptyStringSchema,
    skippedAt: OptionalNonEmptyStringSchema,
    lightweightSubtasks: z.boolean().optional(),
    subtasks: z.array(GoalTaskSchema).optional(),
  }),
);

const GoalTaskListSchema: z.ZodType<GoalTaskList> = z.object({
  tasks: z.array(GoalTaskSchema),
  blockCompletion: z.boolean(),
  proposedAt: NonEmptyStringSchema,
});

const AuditRecordSchema: z.ZodType<AuditRecord> = z.object({
  decision: z.enum(["approved", "rejected"]),
  summary: z.string(),
  auditorSessionID: OptionalNonEmptyStringSchema,
  model: OptionalNonEmptyStringSchema,
  variant: OptionalNonEmptyStringSchema,
  createdAt: NonEmptyStringSchema,
});

const AuditProgressRecordSchema: z.ZodType<AuditProgressRecord> = z.object({
  status: AuditProgressStatusSchema,
  message: z.string(),
  auditorSessionID: OptionalNonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});

const GoalDraftSchema: z.ZodType<GoalDraft> = z.object({
  id: NonEmptyStringSchema,
  sessionID: NonEmptyStringSchema,
  status: GoalDraftStatusSchema,
  topic: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  successCriteria: OptionalNonEmptyStringSchema,
  constraints: OptionalNonEmptyStringSchema,
  verificationContract: OptionalNonEmptyStringSchema,
  taskList: GoalTaskListSchema.optional(),
  budgetOverrides: GoalBudgetObjectSchema.partial().optional(),
  autoContinue: z.boolean(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
});

const SessionExecutionContextSchema: z.ZodType<SessionExecutionContext> = z.object({
  sessionID: NonEmptyStringSchema,
  agent: OptionalNonEmptyStringSchema,
  providerID: OptionalNonEmptyStringSchema,
  modelID: OptionalNonEmptyStringSchema,
  variant: OptionalNonEmptyStringSchema,
  lastUserMessageID: OptionalNonEmptyStringSchema,
  source: ExecutionContextSourceSchema,
  updatedAt: NonEmptyStringSchema,
});

export const GoalRecordSchema: z.ZodType<GoalRecord> = z.object({
  id: NonEmptyStringSchema,
  objective: NonEmptyStringSchema,
  status: GoalStatusSchema,
  autoContinue: z.boolean(),
  createdAt: NonEmptyStringSchema,
  updatedAt: NonEmptyStringSchema,
  sessionID: OptionalNonEmptyStringSchema,
  verificationContract: OptionalNonEmptyStringSchema,
  successCriteria: OptionalNonEmptyStringSchema,
  constraints: OptionalNonEmptyStringSchema,
  stopReason: GoalStopReasonSchema.optional(),
  pauseReason: OptionalNonEmptyStringSchema,
  abortReason: OptionalNonEmptyStringSchema,
  completionSummary: OptionalNonEmptyStringSchema,
  verificationSummary: OptionalNonEmptyStringSchema,
  activePath: OptionalNonEmptyStringSchema,
  archivedPath: OptionalNonEmptyStringSchema,
  taskList: GoalTaskListSchema.optional(),
  budget: GoalBudgetSchema,
  progress: GoalProgressSchema,
  audit: AuditRecordSchema.optional(),
  auditProgress: AuditProgressRecordSchema.optional(),
});

export const GoalStoreSnapshotSchema: z.ZodType<GoalStoreSnapshot> = z.object({
  version: z.literal(1),
  goals: z.array(GoalRecordSchema),
  focusBySession: z.record(z.string(), z.string()),
  drafts: z.record(z.string(), GoalDraftSchema).optional(),
  executionContexts: z.record(z.string(), SessionExecutionContextSchema).optional(),
  auditProgress: z.record(z.string(), AuditProgressRecordSchema).optional(),
  updatedAt: NonEmptyStringSchema,
});

const PluginOptionsSchema = z.object({
  commandName: OptionalNonEmptyStringSchema,
  stateDir: OptionalNonEmptyStringSchema,
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
  auditorModel: OptionalNonEmptyStringSchema,
  auditorAgent: OptionalNonEmptyStringSchema,
  auditorVariant: OptionalNonEmptyStringSchema,
  readonlyAuditor: z.boolean().optional(),
  todoSync: z.boolean().optional(),
  maxTaskCount: z.number().int().positive().optional(),
  maxSubtaskDepth: z.number().int().nonnegative().optional(),
  strictTaskContracts: z.boolean().optional(),
});

type ParsedPluginOptions = z.infer<typeof PluginOptionsSchema>;

export function normalizeOptions(rawOptions: unknown): GoalRuntimeOptions {
  const parsed = PluginOptionsSchema.safeParse(rawOptions);
  if (parsed.success === false) return DEFAULT_OPTIONS;

  const options: ParsedPluginOptions = parsed.data;
  const requireAudit = options.requireAudit ?? options.completionAudit ?? DEFAULT_OPTIONS.requireAudit;
  const maxRuntimeMs = normalizedMaxRuntimeMs(options);

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
    auditorVariant: options.auditorVariant,
    readonlyAuditor: options.readonlyAuditor ?? DEFAULT_OPTIONS.readonlyAuditor,
    todoSync: options.todoSync ?? DEFAULT_OPTIONS.todoSync,
    maxTaskCount: options.maxTaskCount ?? DEFAULT_OPTIONS.maxTaskCount,
    maxSubtaskDepth: options.maxSubtaskDepth ?? DEFAULT_OPTIONS.maxSubtaskDepth,
    strictTaskContracts: options.strictTaskContracts ?? DEFAULT_OPTIONS.strictTaskContracts,
  };
}

function normalizedMaxRuntimeMs(options: ParsedPluginOptions): number {
  if (options.maxRuntimeMs !== undefined) return options.maxRuntimeMs;
  if (options.maxMinutes === undefined) return DEFAULT_OPTIONS.maxRuntimeMs;
  return Math.round(options.maxMinutes * MS_PER_MINUTE);
}

function normalizeCommandName(commandName: string): string {
  if (commandName.startsWith("/")) return commandName.slice(1);
  return commandName;
}
