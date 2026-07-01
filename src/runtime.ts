import { tool, type Config, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import { runCompletionAudit } from "./audit";
import { parseGoalCommand } from "./commands";
import { createGoalDraft, findSessionDraft, formatGoalDraftConfirmation, formatGoalDraftHeaderLines, removeDraft, upsertDraft } from "./draft";
import { DEFAULT_OPTIONS, MEANINGFUL_PROGRESS_TOOLS, PLUGIN_NAME } from "./defaults";
import { errorMessage } from "./errors";
import {
  cleanOptionalText,
  cloneGoal,
  createGoal,
  focusGoal,
  findTask,
  focusedGoal,
  formatGoalList,
  hasPendingBlockingTasks,
  isOpenGoal,
  nowIso,
  openGoals,
  shouldSuppressGenericCompactionAutocontinue,
  summarizeGoal,
  updateGoalStatus,
  updateTaskTree,
  upsertGoal,
} from "./goal";
import { mergeExecutionContext, type ExecutionContextCandidate, type ExecutionModelCandidate } from "./execution-context";
import { normalizeOpenCodeEvent, assistantMessageTokens, type OpenCodeMessageSnapshot } from "./opencode-events";
import { auditPrompt, compactionContext, continuationPrompt, goalSystemPrompt, limitWrapUpPrompt } from "./prompts";
import { normalizeOptions } from "./schemas";
import { buildVariantAwareTextPrompt, type VariantAwareTextPromptInput } from "./session-prompt";
import { appendLedger, loadStore, readLedgerEvents, resolveGoalPaths, saveStore, writeGoalMarkdown } from "./storage";
import { normalizeToolTaskList } from "./task-normalization";
import { hasPendingSubtasks, validateTaskTree, type TaskValidationOptions } from "./task-validation";
import { syncGoalTasksFromTodos } from "./todo-sync";
import type {
  CommandExecutionResult,
  GoalBudget,
  GoalDraft,
  GoalPaths,
  GoalRecord,
  GoalRuntimeOptions,
  GoalStoreSnapshot,
  GoalTask,
  GoalTaskList,
  MaybeUndefined,
  MutableTextPart,
  OperationResult,
  ParsedGoalCommand,
  SessionExecutionContext,
  UnknownRecord,
} from "./types";

const TaskStatusInputSchema = tool.schema.enum(["pending", "complete", "skipped"]).default("pending");

const TaskInputBaseFields = {
  id: tool.schema.string().min(1),
  title: tool.schema.string().min(1),
  status: TaskStatusInputSchema,
  verificationContract: tool.schema.string().min(1).optional(),
  evidence: tool.schema.string().min(1).optional(),
  skipReason: tool.schema.string().min(1).optional(),
  completedAt: tool.schema.string().min(1).optional(),
  skippedAt: tool.schema.string().min(1).optional(),
  lightweightSubtasks: tool.schema.boolean().optional(),
};

const TaskInputSchema = tool.schema.object({
  ...TaskInputBaseFields,
  subtasks: tool.schema.array(tool.schema.unknown()).optional(),
});

const TaskListArgs = {
  tasks: tool.schema.array(TaskInputSchema).min(1),
  blockCompletion: tool.schema.boolean().optional(),
};

const taskListInputSchema = tool.schema.object(TaskListArgs);

const CompletionClaimArgs = {
  completionSummary: tool.schema.string().min(1),
  verificationSummary: tool.schema.string().min(1),
};

const COMMAND_DEDUPE_MS = 2_000;
const COMMAND_INTERRUPTION_IGNORE_MS = 2_000;
const RECENT_DRAFT_CONFIRM_MS = 10_000;

const TaskIdArg = tool.schema.string().min(1);

const ReasonArgs = {
  reason: tool.schema.string().min(1),
};

interface FocusedTaskContext {
  goal: GoalRecord;
  task: GoalTask;
  taskList: GoalTaskList;
}

interface RecentCommandResult {
  signature: string;
  text: string;
  shouldAutoContinue: boolean;
  createdAt: number;
}

type CommandContextInput = Omit<ExecutionContextCandidate, "source" | "timestamp">;
type ChatContextInput = CommandContextInput;
type CompactionContextInput = CommandContextInput & {
  agent: string;
  model: ExecutionModelCandidate;
};

type AuditRecordInput = Pick<NonNullable<GoalRecord["audit"]>, "auditorSessionID" | "model" | "variant">;

export class GoalRuntime {
  private readonly input: PluginInput;
  private readonly options: GoalRuntimeOptions;
  private readonly paths: GoalPaths;
  private store: GoalStoreSnapshot;
  private readonly continuationTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; goalID: string }>();
  private readonly continuationInFlight = new Set<string>();
  private readonly auditorSessionGoals = new Map<string, string>();
  private readonly lastEvaluatedContinuation = new Map<string, number>();
  private readonly recentCommandResults = new Map<string, RecentCommandResult>();
  private readonly commandInterruptionIgnoreUntil = new Map<string, number>();

  constructor(input: PluginInput, rawOptions: unknown) {
    this.input = input;
    this.options = normalizeOptions(rawOptions);
    this.paths = resolveGoalPaths(input.directory, this.options.stateDir);
    this.store = loadStore(this.paths);
  }

  hooks(): Hooks {
    return {
      dispose: async () => {
        this.dispose();
      },
      config: async (config) => {
        this.registerCommands(config);
      },
      event: async ({ event }) => {
        await this.handleEvent(event);
      },
      "chat.message": async (input, output) => {
        this.captureChatMessageContext(input, output.message.id);
        this.handleUserInterruption(input.sessionID, output.message.id);
      },
      "command.execute.before": async (input, output) => {
        this.captureCommandExecutionContext(input);
        await this.handleCommand(input.command, input.sessionID, input.arguments, output.parts);
      },
      "experimental.chat.system.transform": async (input, output) => {
        this.appendGoalSystemContext(input.sessionID, output.system);
      },
      "experimental.session.compacting": async (input, output) => {
        this.appendCompactionContext(input.sessionID, output.context);
      },
      "experimental.compaction.autocontinue": async (input, output) => {
        this.captureCompactionExecutionContext(input);
        this.disableCompactionAutocontinue(input.sessionID, output);
      },
      "tool.execute.after": async (input, output) => {
        this.trackToolExecution(input.sessionID, input.tool, output.output);
      },
      tool: this.toolDefinitions(),
    };
  }

  private dispose(): void {
    for (const timerState of this.continuationTimers.values()) clearTimeout(timerState.timer);
    this.continuationTimers.clear();
    this.continuationInFlight.clear();
    this.recentCommandResults.clear();
    this.commandInterruptionIgnoreUntil.clear();
  }

  private appendGoalSystemContext(sessionID: MaybeUndefined<string>, system: string[]): void {
    if (sessionID === undefined) return;
    const goal = this.openFocusedGoal(sessionID);
    if (goal === undefined) return;
    system.push(goalSystemPrompt(goal));
  }

  private appendCompactionContext(sessionID: string, context: string[]): void {
    const goal = this.openFocusedGoal(sessionID);
    if (goal === undefined) return;
    context.push(compactionContext({
      focusedGoal: goal,
      openGoals: openGoals(this.store),
      recentLedgerEvents: readLedgerEvents(this.paths, 8),
    }));
  }

  private disableCompactionAutocontinue(sessionID: string, output: { enabled: boolean }): void {
    const goal = this.autoContinuingGoal(sessionID);
    if (shouldSuppressGenericCompactionAutocontinue(goal) === false) return;
    const queued = this.queueContinuation(sessionID, "post-compaction");
    if (queued === false) return;
    output.enabled = false;
  }

  private registerCommands(config: Config): void {
    if (config.command === undefined) config.command = {};
    const commandName = this.options.commandName;
    this.registerCommand(config, commandName, {
      description: "Draft a durable opencode-goal-x objective for explicit confirmation, or manage existing goals.",
      template: "$ARGUMENTS",
    });
    this.registerCommand(config, `${commandName}-set`, {
      description: "Start a durable opencode-goal-x objective immediately.",
      template: "$ARGUMENTS",
    });
    this.registerCommand(config, `${commandName}-confirm`, {
      description: "Confirm the latest drafted opencode-goal-x objective and start it.",
      template: "$ARGUMENTS",
    });
    this.registerCommand(config, `${commandName}-reject`, {
      description: "Discard the latest drafted opencode-goal-x objective without creating a goal.",
      template: "$ARGUMENTS",
    });
    this.registerCommand(config, `${commandName}-status`, { description: "Show the focused goal status.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-list`, { description: "List open goals.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-focus`, { description: "Focus an open goal by number or id.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-pause`, { description: "Pause the focused goal.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-resume`, { description: "Resume the focused paused goal.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-tweak`, { description: "Revise the focused goal objective.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-abort`, { description: "Abort and archive the focused goal.", template: "$ARGUMENTS" });
    this.registerCommand(config, `${commandName}-clear`, { description: "Clear and archive the focused goal.", template: "$ARGUMENTS" });
  }

  private registerCommand(config: Config, command: string, definition: NonNullable<Config["command"]>[string]): void {
    if (config.command === undefined) config.command = {};
    config.command[command] = definition;
  }

  private async handleCommand(command: string, sessionID: string, rawArguments: string, parts: MutableTextPart[]): Promise<void> {
    if (this.ownsCommand(command) === false) return;
    const signature = commandSignature(command, rawArguments);
    const cached = this.recentCommandResult(sessionID, signature);
    if (cached !== undefined) {
      this.replaceCommandText(parts, cached.text);
      return;
    }

    this.refreshStore();
    const parsed = parseGoalCommand(command, this.options.commandName, rawArguments);
    if (parsed.ok === false) {
      this.replaceCommandText(parts, `opencode-goal-x command rejected: ${parsed.message}`);
      await this.toast(parsed.message, "error");
      return;
    }

    const result = await this.executeParsedCommand(sessionID, parsed.value);
    this.replaceCommandText(parts, result.text);
    this.rememberCommandResult(sessionID, signature, result);
    await this.toast(result.text.split("\n")[0] ?? "opencode-goal-x", "info");
    if (result.shouldAutoContinue) {
      this.ignoreCommandInterruption(sessionID);
      this.queueContinuation(sessionID, "command");
    }
  }

  private recentCommandResult(sessionID: string, signature: string): MaybeUndefined<RecentCommandResult> {
    const cached = this.recentCommandResults.get(sessionID);
    if (cached === undefined) return undefined;
    if (cached.signature !== signature) return undefined;
    if (Date.now() - cached.createdAt > COMMAND_DEDUPE_MS) return undefined;
    return cached;
  }

  private rememberCommandResult(sessionID: string, signature: string, result: CommandExecutionResult): void {
    this.recentCommandResults.set(sessionID, {
      signature,
      text: result.text,
      shouldAutoContinue: result.shouldAutoContinue,
      createdAt: Date.now(),
    });
  }

  private ignoreCommandInterruption(sessionID: string): void {
    this.commandInterruptionIgnoreUntil.set(sessionID, Date.now() + COMMAND_INTERRUPTION_IGNORE_MS);
  }

  private ownsCommand(command: string): boolean {
    const base = this.options.commandName;
    return command === base || command.startsWith(`${base}-`);
  }

  private replaceCommandText(parts: MutableTextPart[], text: string): void {
    for (const part of parts) {
      if (part.type !== "text") continue;
      part.text = text;
      return;
    }
  }

  private async executeParsedCommand(sessionID: string, command: ParsedGoalCommand): Promise<CommandExecutionResult> {
    if (command.action === "draft") {
      if (command.objective === undefined) return handled("Goal draft topic is empty.", false);
      return handled(this.startGoalDraftCommand(sessionID, command), false);
    }

    if (command.action === "start") {
      if (command.objective === undefined) return handled("Goal objective is empty.", false);
      const goal = createGoal({
        objective: command.objective,
        sessionID,
        autoContinue: true,
        budgetOverrides: this.goalBudgetOverrides(command.budgetOverrides),
        successCriteria: command.successCriteria,
        constraints: command.constraints,
        verificationContract: command.verificationContract,
      });
      const saved = this.persistGoal(goal, sessionID, "goal_started_immediate");
      return handled(`Goal started immediately from /${this.options.commandName}-set.\n\n${summarizeGoal(saved)}\n\nThe auto-continue loop is armed.`, true);
    }

    if (command.action === "confirm") {
      const confirmText = this.confirmGoalDraftCommand(sessionID, command.goalId);
      return handled(confirmText, confirmText.startsWith("Goal draft confirmed."));
    }
    if (command.action === "reject") return handled(this.rejectGoalDraftCommand(sessionID, command.goalId), false);

    if (command.action === "status") {
      const goal = focusedGoal(this.store, sessionID);
      return handled(goal === undefined ? this.noGoalText() : summarizeGoal(goal), false);
    }

    if (command.action === "list") return handled(formatGoalList(this.store, sessionID), false);

    if (command.action === "focus") return handled(this.focusGoalCommand(sessionID, command.goalId), false);

    if (command.action === "pause") return handled(this.pauseFocusedGoal(sessionID, cleanOptionalText(command.reason) ?? "Paused by user.", "user"), false);

    if (command.action === "resume") {
      const resumeText = this.resumeFocusedGoal(sessionID);
      return handled(resumeText, resumeText.startsWith("Goal resumed."));
    }

    if (command.action === "tweak") {
      if (command.objective === undefined || command.objective.trim().length === 0) return handled("Provide the revised objective after /goal-tweak.", false);
      const tweakText = this.tweakFocusedGoal(sessionID, command.objective);
      return handled(tweakText, tweakText.startsWith("Goal revised."));
    }

    if (command.action === "abort") return handled(this.abortFocusedGoal(sessionID, cleanOptionalText(command.reason) ?? "Aborted by user."), false);
    if (command.action === "clear") return handled(this.abortFocusedGoal(sessionID, "Cleared by user."), false);

    return handled(helpText(this.options.commandName), false);
  }

  private startGoalDraftCommand(sessionID: string, command: { objective?: string; successCriteria?: string; constraints?: string; verificationContract?: string; budgetOverrides: Partial<GoalBudget> }): string {
    if (command.objective === undefined) return "Goal draft topic is empty.";
    const existingDraft = this.matchingSessionDraft(sessionID, command.objective);
    if (existingDraft !== undefined) {
      if (existingDraft.status === "proposed") return formatGoalDraftConfirmation(existingDraft);
      return this.formatDraftRequest(existingDraft);
    }

    const draft = createGoalDraft({
      sessionID,
      topic: command.objective,
      objective: command.objective,
      successCriteria: command.successCriteria,
      constraints: command.constraints,
      verificationContract: command.verificationContract,
      budgetOverrides: this.goalBudgetOverrides(command.budgetOverrides),
      autoContinue: true,
      status: "planning",
    });
    this.persistDraft(draft, sessionID, "goal_draft_requested");
    return this.formatDraftRequest(draft);
  }

  private formatDraftRequest(draft: Pick<GoalDraft, "id" | "status" | "topic">): string {
    return [
      "Goal drafting started. No goal has been created and no implementation should start yet.",
      "",
      ...formatGoalDraftHeaderLines(draft),
      "",
      "Discuss/refine the goal in this session, then call propose_goal_draft with the finalized objective and optional tasks.",
      `For an immediate start without drafting, use /${this.options.commandName}-set <objective>.`,
    ].join("\n");
  }

  private confirmGoalDraftCommand(sessionID: string, selector: MaybeUndefined<string>): string {
    const draftID = cleanOptionalText(selector);
    const draft = findSessionDraft(this.store.drafts, sessionID, draftID);
    if (draft === undefined) {
      const confirmedGoal = this.confirmedDraftGoal(sessionID, draftID);
      if (confirmedGoal !== undefined) return this.alreadyConfirmedText(confirmedGoal);
      return "No pending goal draft to confirm.";
    }
    if (draft.status !== "proposed") {
      const confirmedGoal = this.confirmedDraftGoal(sessionID, draftID);
      if (confirmedGoal !== undefined) return this.alreadyConfirmedText(confirmedGoal);
      return "No finalized goal draft to confirm. Continue the discussion until the assistant calls propose_goal_draft with the finalized objective.";
    }
    const goal = createGoal({
      objective: draft.objective,
      sessionID,
      autoContinue: draft.autoContinue,
      budgetOverrides: this.goalBudgetOverrides(draft.budgetOverrides),
      successCriteria: draft.successCriteria,
      constraints: draft.constraints,
      verificationContract: draft.verificationContract,
    });
    const withTasks = draft.taskList === undefined ? goal : { ...goal, taskList: draft.taskList };
    this.removeDraftRecord(draft.id, sessionID, "goal_draft_confirmed", { goalId: goal.id });
    const saved = this.persistGoal(withTasks, sessionID, "goal_started_from_draft");
    return `Goal draft confirmed.\n\n${summarizeGoal(saved)}\n\nThe auto-continue loop is armed.`;
  }

  private alreadyConfirmedText(goal: GoalRecord): string {
    return `Goal draft already confirmed.\n\n${summarizeGoal(goal)}\n\nThe auto-continue loop is armed.`;
  }

  private rejectGoalDraftCommand(sessionID: string, selector: MaybeUndefined<string>): string {
    const draftID = cleanOptionalText(selector);
    const draft = findSessionDraft(this.store.drafts, sessionID, draftID);
    if (draft === undefined) {
      if (draftID !== undefined && this.wasDraftRejected(sessionID, draftID)) return `Goal draft already rejected. No goal was created. Draft ID: ${draftID}`;
      return "No pending goal draft to reject.";
    }
    this.removeDraftRecord(draft.id, sessionID, "goal_draft_rejected");
    return `Goal draft rejected. No goal was created. Draft ID: ${draft.id}`;
  }

  private matchingSessionDraft(sessionID: string, objective: string): MaybeUndefined<GoalDraft> {
    const objectiveText = objective.trim();
    if (objectiveText.length === 0) return undefined;
    if (this.store.drafts === undefined) return undefined;
    let latest: MaybeUndefined<GoalDraft>;
    for (const draft of Object.values(this.store.drafts)) {
      if (draft.sessionID !== sessionID) continue;
      if (draft.objective !== objectiveText) continue;
      if (latest === undefined) {
        latest = draft;
        continue;
      }
      if (draft.updatedAt > latest.updatedAt) latest = draft;
    }
    return latest;
  }

  private confirmedDraftGoal(sessionID: string, draftID: MaybeUndefined<string>): MaybeUndefined<GoalRecord> {
    const recentEvents = readLedgerEvents(this.paths, 200);
    for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
      const event = recentEvents[index];
      if (event === undefined) continue;
      if (ledgerText(event, "type") !== "goal_draft_confirmed") continue;
      if (ledgerText(event, "sessionID") !== sessionID) continue;
      if (draftID !== undefined && ledgerText(event, "draftId") !== draftID) continue;
      if (draftID === undefined && isRecentLedgerEvent(event, RECENT_DRAFT_CONFIRM_MS) === false) continue;
      const goalID = ledgerText(event, "goalId");
      if (goalID === undefined) continue;
      const goal = this.store.goals.find((candidate) => candidate.id === goalID);
      if (goal === undefined) continue;
      this.store = focusGoal(this.store, sessionID, goal.id);
      saveStore(this.paths, this.store);
      return goal;
    }
    return undefined;
  }

  private wasDraftRejected(sessionID: string, draftID: string): boolean {
    const recentEvents = readLedgerEvents(this.paths, 200);
    for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
      const event = recentEvents[index];
      if (event === undefined) continue;
      if (ledgerText(event, "type") !== "goal_draft_rejected") continue;
      if (ledgerText(event, "sessionID") !== sessionID) continue;
      if (ledgerText(event, "draftId") !== draftID) continue;
      return true;
    }
    return false;
  }

  private focusGoalCommand(sessionID: string, selector: MaybeUndefined<string>): string {
    const goals = openGoals(this.store);
    if (goals.length === 0) return "No open goals to focus.";
    if (selector === undefined || selector.trim().length === 0) return formatGoalList(this.store, sessionID);
    const trimmed = selector.trim();
    const goal = findOpenGoalBySelector(goals, trimmed);
    if (goal === undefined) return `No open goal matches: ${trimmed}`;
    this.store = focusGoal(this.store, sessionID, goal.id);
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: "goal_focused", goalId: goal.id, sessionID });
    return `Focused goal ${goal.id}.\n\n${summarizeGoal(goal)}`;
  }

  private pauseFocusedGoal(sessionID: string, reason: string, stopReason: "user" | "agent"): string {
    const goal = this.activeGoalOrMessage(sessionID);
    if (typeof goal === "string") return goal;
    const next = updateGoalStatus(goal, "paused", {
      autoContinue: false,
      stopReason,
      pauseReason: reason,
    });
    this.persistGoal(next, sessionID, "goal_paused");
    this.clearContinuation(sessionID);
    return `Goal paused.\n\n${summarizeGoal(next)}`;
  }

  private resumeFocusedGoal(sessionID: string): string {
    let goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) {
      const goals = openGoals(this.store);
      if (goals.length === 1) {
        const onlyGoal = goals[0];
        if (onlyGoal !== undefined) {
          this.store = focusGoal(this.store, sessionID, onlyGoal.id);
          goal = onlyGoal;
        }
      }
    }
    if (goal === undefined) return this.noGoalText();
    if (goal.status === "active") return "Goal is already active.";
    if (goal.status !== "paused") return `Cannot resume a ${goal.status} goal.`;

    const next = this.restartGoalRun(sessionID, goal, {}, "goal_resumed");
    return `Goal resumed.\n\n${summarizeGoal(next)}`;
  }

  private tweakFocusedGoal(sessionID: string, objective: string): string {
    const goal = this.openLifecycleGoalOrMessage(sessionID, "tweak");
    if (typeof goal === "string") return goal;
    const next = this.restartGoalRun(sessionID, goal, { objective: objective.trim() }, "goal_tweaked");
    return `Goal revised.\n\n${summarizeGoal(next)}`;
  }

  private restartGoalRun(sessionID: string, goal: GoalRecord, updates: Partial<GoalRecord>, eventType: string): GoalRecord {
    const next = updateGoalStatus(goal, "active", {
      ...updates,
      autoContinue: true,
      stopReason: undefined,
      pauseReason: undefined,
      progress: resetGoalRunProgress(goal),
    });
    return this.persistGoal(next, sessionID, eventType);
  }

  private abortFocusedGoal(sessionID: string, reason: string): string {
    const goal = this.focusedGoalOrMessage(sessionID);
    if (typeof goal === "string") return goal;
    const next = updateGoalStatus(goal, "aborted", {
      autoContinue: false,
      stopReason: "user",
      abortReason: reason,
    });
    const saved = this.persistAndUnfocus(sessionID, next, "goal_aborted");
    return `Goal aborted.\n\n${summarizeGoal(saved)}`;
  }

  private noGoalText(): string {
    return `No focused goal. Use /${this.options.commandName} <topic> to draft one, or /${this.options.commandName}-set <objective> to start immediately.`;
  }

  private persistGoal(goal: GoalRecord, sessionID: string, eventType: string): GoalRecord {
    this.refreshStore();
    const saved = writeGoalMarkdown(this.paths, { ...cloneGoal(goal), updatedAt: nowIso() });
    this.store = upsertGoal(this.store, saved);
    if (saved.auditProgress !== undefined) this.mergeAuditProgress(saved.id, saved.auditProgress);
    if (saved.status === "active" || saved.status === "paused") this.store = focusGoal(this.store, sessionID, saved.id);
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: eventType, goalId: saved.id, sessionID, status: saved.status });
    return saved;
  }

  private persistDraft(draft: GoalDraft, sessionID: string, eventType: string): void {
    this.store = { ...this.store, drafts: upsertDraft(this.store.drafts, draft), updatedAt: nowIso() };
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: eventType, draftId: draft.id, sessionID });
  }

  private removeDraftRecord(draftID: string, sessionID: string, eventType: string, extra: UnknownRecord = {}): void {
    this.store = { ...this.store, drafts: removeDraft(this.store.drafts, draftID), updatedAt: nowIso() };
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: eventType, draftId: draftID, sessionID, ...extra });
  }

  private refreshStore(): void {
    this.store = loadStore(this.paths);
  }

  private mergeAuditProgress(goalID: string, auditProgress: NonNullable<GoalRecord["auditProgress"]>): void {
    this.store = {
      ...this.store,
      auditProgress: {
        ...this.store.auditProgress,
        [goalID]: auditProgress,
      },
      updatedAt: nowIso(),
    };
  }

  private async handleEvent(event: unknown): Promise<void> {
    this.refreshStore();
    const normalizedEvent = normalizeOpenCodeEvent(event);
    if (normalizedEvent.ok === false) {
      await this.log("debug", "Ignored malformed OpenCode event payload.", { reason: normalizedEvent.message });
      return;
    }

    const openCodeEvent = normalizedEvent.value;
    if (openCodeEvent.type === "session.idle") {
      await this.handleIdle(openCodeEvent.sessionID);
      return;
    }
    if (openCodeEvent.type === "session.compacted") {
      this.queueContinuation(openCodeEvent.sessionID, "compacted");
      return;
    }
    if (openCodeEvent.type === "message.updated") {
      this.captureMessageExecutionContext(openCodeEvent.info);
      this.trackAssistantMessage(openCodeEvent.info);
      return;
    }
    this.syncTodos(openCodeEvent.sessionID, openCodeEvent.todos);
  }

  private captureCommandExecutionContext(input: CommandContextInput): void {
    this.recordExecutionContext({ ...input, source: "command.execute.before" });
  }

  private captureChatMessageContext(input: ChatContextInput, messageID: string): void {
    this.recordExecutionContext({ ...input, messageID, source: "chat.message" });
  }

  private captureCompactionExecutionContext(input: CompactionContextInput): void {
    this.recordExecutionContext({ ...input, source: "compaction.autocontinue" });
  }

  private captureMessageExecutionContext(message: OpenCodeMessageSnapshot): void {
    if (message.role !== "user") return;
    this.recordExecutionContext({
      sessionID: message.sessionID,
      agent: message.agent,
      model: message.model,
      messageID: message.id,
      source: "message.updated",
      timestamp: message.time.created,
    });
  }

  private recordExecutionContext(input: CommandContextInput & { source: SessionExecutionContext["source"]; timestamp?: number }): void {
    const existing = this.executionContextFor(input.sessionID);
    const next = mergeExecutionContext(existing, input);
    this.store = {
      ...this.store,
      executionContexts: {
        ...this.store.executionContexts,
        [input.sessionID]: next,
      },
      updatedAt: nowIso(),
    };
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: "goal_context_captured", sessionID: input.sessionID, source: input.source, agent: next.agent, model: next.modelID, variant: next.variant });
  }

  private executionContextFor(sessionID: string): MaybeUndefined<SessionExecutionContext> {
    const contexts = this.store.executionContexts;
    if (contexts === undefined) return undefined;
    return contexts[sessionID];
  }

  private handleUserInterruption(sessionID: string, messageID: string): void {
    if (this.shouldIgnoreCommandInterruption(sessionID)) return;
    if (this.continuationTimers.has(sessionID) === false && this.continuationInFlight.has(sessionID) === false) return;
    const goal = this.autoContinuingGoal(sessionID);
    if (goal === undefined) return;
    const next = updateGoalStatus(goal, "paused", {
      autoContinue: false,
      stopReason: "user",
      pauseReason: `User message ${messageID} interrupted the auto-continue loop.`,
    });
    this.persistGoal(next, sessionID, "goal_user_interrupted");
    this.clearContinuation(sessionID);
    appendLedger(this.paths, { type: "goal_user_interruption_detail", goalId: goal.id, sessionID, messageID });
  }

  private shouldIgnoreCommandInterruption(sessionID: string): boolean {
    const ignoreUntil = this.commandInterruptionIgnoreUntil.get(sessionID);
    if (ignoreUntil === undefined) return false;
    if (Date.now() <= ignoreUntil) return true;
    this.commandInterruptionIgnoreUntil.delete(sessionID);
    return false;
  }

  private syncTodos(sessionID: string, todos: unknown): void {
    if (this.options.todoSync === false) return;
    const goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) return;
    const result = syncGoalTasksFromTodos(goal, todos);
    if (result.validationError !== undefined) {
      appendLedger(this.paths, { type: "goal_todo_sync_rejected", goalId: goal.id, sessionID, reason: result.validationError });
      return;
    }
    if (result.updates.length === 0) return;
    this.persistGoal(result.goal, sessionID, "goal_todo_synced");
    appendLedger(this.paths, { type: "goal_todo_sync_detail", goalId: goal.id, sessionID, updates: result.updates });
  }

  private trackAssistantMessage(message: OpenCodeMessageSnapshot): void {
    const tokens = assistantMessageTokens(message);
    if (tokens === undefined) return;
    const goal = this.activeFocusedGoal(message.sessionID);
    if (goal === undefined) return;
    const tokenTotal = tokens.input + tokens.output + tokens.reasoning;
    const next = {
      ...goal,
      progress: {
        ...goal.progress,
        tokensUsed: Math.max(goal.progress.tokensUsed, tokenTotal),
        lastAssistantOutputTokens: tokens.output,
      },
      updatedAt: nowIso(),
    };
    this.persistGoal(next, message.sessionID, "goal_accounted");
  }

  private trackToolExecution(sessionID: string, toolName: string, toolOutput: string): void {
    const goal = this.activeFocusedGoal(sessionID);
    if (goal === undefined) return;
    if (MEANINGFUL_PROGRESS_TOOLS.has(toolName) === false) return;
    const checkpoint = toolOutput.trim().slice(0, 800);
    const next = {
      ...goal,
      progress: {
        ...goal.progress,
        toolCallsSinceLastContinue: goal.progress.toolCallsSinceLastContinue + 1,
        latestCheckpoint: checkpoint.length === 0 ? goal.progress.latestCheckpoint : checkpoint,
      },
      updatedAt: nowIso(),
    };
    this.persistGoal(next, sessionID, "goal_tool_progress");
  }

  private async handleIdle(sessionID: string): Promise<void> {
    const goal = this.autoContinuingGoal(sessionID);
    if (goal === undefined) return;
    const evaluated = this.evaluatePreviousContinuation(sessionID, goal);
    const guardReason = this.guardReason(evaluated);
    if (guardReason !== undefined) {
      await this.pauseForLimit(sessionID, evaluated, guardReason);
      return;
    }
    this.queueContinuation(sessionID, "idle");
  }

  private evaluatePreviousContinuation(sessionID: string, goal: GoalRecord): GoalRecord {
    if (goal.progress.lastContinuedAt === undefined) return goal;
    const lastEvaluated = this.lastEvaluatedContinuation.get(sessionID);
    if (lastEvaluated === goal.progress.lastContinuedAt) return goal;
    this.lastEvaluatedContinuation.set(sessionID, goal.progress.lastContinuedAt);

    const hadToolCall = goal.progress.toolCallsSinceLastContinue > 0;
    const lowOutput = goal.progress.lastAssistantOutputTokens !== undefined && goal.progress.lastAssistantOutputTokens < goal.budget.noProgressTokenThreshold;
    const next = {
      ...goal,
      progress: {
        ...goal.progress,
        noToolCallTurns: hadToolCall ? 0 : goal.progress.noToolCallTurns + 1,
        noProgressTurns: hadToolCall || !lowOutput ? 0 : goal.progress.noProgressTurns + 1,
      },
      updatedAt: nowIso(),
    };
    return this.persistGoal(next, sessionID, "goal_guard_accounted");
  }

  private guardReason(goal: GoalRecord): MaybeUndefined<string> {
    if (goal.progress.continuationTurns >= goal.budget.maxTurns) return `maximum continuation turns reached (${goal.budget.maxTurns})`;
    if (Date.now() - goal.progress.startedAt >= goal.budget.maxRuntimeMs) return `maximum runtime reached (${goal.budget.maxRuntimeMs}ms)`;
    if (goal.progress.tokensUsed >= goal.budget.maxTokens) return `maximum tracked tokens reached (${goal.budget.maxTokens})`;
    if (goal.progress.promptFailures >= goal.budget.maxPromptFailures) return `maximum prompt failures reached (${goal.budget.maxPromptFailures})`;
    if (goal.progress.noToolCallTurns >= goal.budget.noToolCallTurnsBeforePause) return "repeated continuation turns used no tools";
    if (goal.progress.noProgressTurns >= goal.budget.noProgressTurnsBeforePause) return "repeated continuation turns made too little progress";
    return undefined;
  }

  private queueContinuation(sessionID: string, reason: string): boolean {
    const goal = this.autoContinuingGoal(sessionID);
    if (goal === undefined) return false;
    if (this.continuationInFlight.has(sessionID)) return false;
    if (this.continuationTimers.has(sessionID)) return false;

    const lastContinuedAt = goal.progress.lastContinuedAt ?? 0;
    const elapsed = Date.now() - lastContinuedAt;
    const delay = Math.max(0, goal.budget.minDelayMs - elapsed);
    const timer = setTimeout(() => {
      this.continuationTimers.delete(sessionID);
      this.runBackgroundTask(this.sendContinuation(sessionID, reason, goal.id), "Goal continuation failed unexpectedly.", { goalId: goal.id, sessionID, reason });
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.continuationTimers.set(sessionID, { timer, goalID: goal.id });
    appendLedger(this.paths, { type: "goal_continuation_scheduled", goalId: goal.id, sessionID, reason, delay });
    return true;
  }

  private clearContinuation(sessionID: string): void {
    const timerState = this.continuationTimers.get(sessionID);
    if (timerState !== undefined) clearTimeout(timerState.timer);
    this.continuationTimers.delete(sessionID);
    this.continuationInFlight.delete(sessionID);
  }

  private async sendContinuation(sessionID: string, reason: string, expectedGoalID: string): Promise<void> {
    const goal = this.autoContinuingGoal(sessionID);
    if (goal === undefined) return;
    if (goal.id !== expectedGoalID) {
      appendLedger(this.paths, { type: "goal_stale_continuation_ignored", expectedGoalID, actualGoalID: goal.id, sessionID, reason });
      return;
    }
    this.continuationInFlight.add(sessionID);
    const next = this.persistGoal({
      ...goal,
      progress: {
        ...goal.progress,
        continuationTurns: goal.progress.continuationTurns + 1,
        lastContinuedAt: Date.now(),
        toolCallsSinceLastContinue: 0,
      },
      updatedAt: nowIso(),
    }, sessionID, "goal_continuation_queued");

    try {
      const response = await this.input.client.session.prompt(this.sessionPromptInput(sessionID, continuationPrompt(next)));
      if (response.error !== undefined) {
        this.recordPromptFailure(sessionID, next, "OpenCode returned an error for the continuation prompt.");
        return;
      }
      const info = response.data.info;
      const tokensUsed = info.tokens.input + info.tokens.output + info.tokens.reasoning;
      this.persistGoal({
        ...next,
        progress: {
          ...next.progress,
          tokensUsed: Math.max(next.progress.tokensUsed, tokensUsed),
          lastAssistantOutputTokens: info.tokens.output,
          promptFailures: 0,
        },
        updatedAt: nowIso(),
      }, sessionID, "goal_continuation_completed");
      appendLedger(this.paths, { type: "goal_continuation_reason", goalId: next.id, sessionID, reason });
    } catch (error) {
      this.recordPromptFailure(sessionID, next, errorMessage(error));
    } finally {
      this.continuationInFlight.delete(sessionID);
    }
  }

  private recordPromptFailure(sessionID: string, goal: GoalRecord, message: string): void {
    const next = this.persistGoal({
      ...goal,
      progress: {
        ...goal.progress,
        promptFailures: goal.progress.promptFailures + 1,
      },
      updatedAt: nowIso(),
    }, sessionID, "goal_prompt_failed");
    this.runBackgroundTask(this.log("warn", `Goal continuation prompt failed: ${message}`, { goalId: goal.id, sessionID }), "Goal continuation failure logging failed.", { goalId: goal.id, sessionID });
    const guardReason = this.guardReason(next);
    if (guardReason === undefined) return;
    this.runBackgroundTask(this.pauseForLimit(sessionID, next, guardReason), "Goal limit pause failed unexpectedly.", { goalId: next.id, sessionID, guardReason });
  }

  private async pauseForLimit(sessionID: string, goal: GoalRecord, reason: string): Promise<void> {
    const next = updateGoalStatus(goal, "paused", {
      autoContinue: false,
      stopReason: "limit",
      pauseReason: reason,
    });
    this.persistGoal(next, sessionID, "goal_limit_paused");
    this.clearContinuation(sessionID);
    await this.toast(`Goal paused: ${reason}`, "warning");
    try {
      await this.input.client.session.prompt(this.sessionPromptInput(sessionID, limitWrapUpPrompt(next, reason)));
    } catch (error) {
      await this.log("warn", `Could not send goal limit wrap-up prompt: ${errorMessage(error)}`);
    }
  }

  private toolDefinitions(): Hooks["tool"] {
    return {
      get_goal: tool({
        description: "Read the focused opencode-goal-x goal, lifecycle state, budgets, tasks, and verification contract.",
        args: {},
        execute: async (_args, context) => {
          const goal = this.focusedGoalOrMessage(context.sessionID);
          if (typeof goal === "string") return goal;
          return summarizeGoal(goal);
        },
      }),
      propose_goal_draft: tool({
        description: "Present a finalized goal draft for explicit user confirmation. This never creates or starts a goal by itself.",
        args: {
          objective: tool.schema.string().min(1),
          successCriteria: tool.schema.string().min(1).optional(),
          constraints: tool.schema.string().min(1).optional(),
          verificationContract: tool.schema.string().min(1).optional(),
          autoContinue: tool.schema.boolean().optional(),
          tasks: tool.schema.array(TaskInputSchema).optional(),
          blockCompletion: tool.schema.boolean().optional(),
          confirmUserIntent: tool.schema.boolean().optional().describe("Deprecated compatibility field ignored by opencode-goal-x; use /goal-confirm for confirmation."),
        },
        execute: async (args, context) => {
          this.refreshStore();
          const parsedTasks = args.tasks === undefined ? undefined : taskListInputSchema.safeParse({ tasks: args.tasks, blockCompletion: args.blockCompletion });
          if (parsedTasks !== undefined && !parsedTasks.success) return "Goal draft rejected: invalid task shape.";
          const normalizedTasks = parsedTasks === undefined ? undefined : normalizeToolTaskList(parsedTasks.data.tasks);
          if (normalizedTasks !== undefined && !normalizedTasks.ok) return normalizedTasks.message;
          const taskList = parsedTasks === undefined || normalizedTasks === undefined
            ? undefined
            : {
                tasks: normalizedTasks.value,
                blockCompletion: parsedTasks.data.blockCompletion ?? true,
                proposedAt: nowIso(),
              };
          if (taskList !== undefined) {
            const validation = validateTaskTree(taskList.tasks, this.taskValidationOptions());
            if (validation.ok === false) return validation.message;
          }
          const draft = createGoalDraft({
            sessionID: context.sessionID,
            topic: args.objective,
            objective: args.objective,
            successCriteria: args.successCriteria,
            constraints: args.constraints,
            verificationContract: args.verificationContract,
            taskList,
            budgetOverrides: this.goalBudgetOverrides(undefined),
            autoContinue: args.autoContinue ?? true,
            status: "proposed",
          });
          this.persistDraft(draft, context.sessionID, "goal_draft_proposed");
          const confirmation = formatGoalDraftConfirmation(draft);
          await this.toast(`Goal draft ready. Confirm with /${this.options.commandName}-confirm ${draft.id}`, "success");
          return `Show this confirmation to the user:\n\n${confirmation}`;
        },
      }),
      propose_goal_tweak: tool({
        description: "Revise the focused goal objective after explicit user instruction. This is the only sanctioned objective mutation path.",
        args: {
          newObjective: tool.schema.string().min(1),
          changeSummary: tool.schema.string().min(1).optional(),
        },
        execute: async (args, context) => {
          const result = this.tweakFocusedGoal(context.sessionID, args.newObjective);
          if (result.startsWith("Goal revised.")) this.queueContinuation(context.sessionID, "tool-tweak");
          return args.changeSummary === undefined ? result : `${result}\n\nChange: ${args.changeSummary}`;
        },
      }),
      pause_goal: tool({
        description: "Pause the focused active goal because of a real blocker. Provide a concrete reason and suggested next action.",
        args: {
          ...ReasonArgs,
          suggestedAction: tool.schema.string().min(1).optional(),
        },
        execute: async (args, context) => {
          const reason = args.suggestedAction === undefined ? args.reason : `${args.reason} Suggested action: ${args.suggestedAction}`;
          return this.pauseFocusedGoal(context.sessionID, reason, "agent");
        },
      }),
      abort_goal: tool({
        description: "Abort and archive the focused goal when it is obsolete, impossible, unsafe, or explicitly cancelled.",
        args: ReasonArgs,
        execute: async (args, context) => this.abortFocusedGoal(context.sessionID, args.reason),
      }),
      propose_task_list: tool({
        description: "Attach or replace a structured task list for the focused goal. Tasks are progress trackers and can block completion.",
        args: TaskListArgs,
        execute: async (args, context) => {
          this.refreshStore();
          const parsed = taskListInputSchema.safeParse(args);
          if (parsed.success === false) return "Task list rejected: invalid task shape.";
          const normalizedTasks = normalizeToolTaskList(parsed.data.tasks);
          if (normalizedTasks.ok === false) return normalizedTasks.message;
          const validation = validateTaskTree(normalizedTasks.value, this.taskValidationOptions());
          if (validation.ok === false) return validation.message;
          const goal = focusedGoal(this.store, context.sessionID);
          if (goal === undefined) return this.noGoalText();
          const taskList: GoalTaskList = {
            tasks: normalizedTasks.value,
            blockCompletion: parsed.data.blockCompletion ?? true,
            proposedAt: nowIso(),
          };
          const next = this.persistGoal({ ...goal, taskList, updatedAt: nowIso() }, context.sessionID, "goal_task_list_set");
          return `Task list accepted.\n\n${summarizeGoal(next)}`;
        },
      }),
      complete_task: tool({
        description: "Mark a task complete with evidence. If it has a verification contract, evidence must address it.",
        args: {
          taskId: TaskIdArg,
          verificationSummary: tool.schema.string().min(1),
        },
        execute: async (args, context) => this.completeTask(context.sessionID, args.taskId, args.verificationSummary),
      }),
      skip_task: tool({
        description: "Skip a task only when explicitly user-approved or contradicted by a hard constraint. Provide a concrete reason.",
        args: {
          taskId: TaskIdArg,
          reason: tool.schema.string().min(1),
        },
        execute: async (args, context) => this.skipTask(context.sessionID, args.taskId, args.reason),
      }),
      complete_goal: tool({
        description: "Claim the focused goal is complete. Requires concrete completion and verification summaries; launches a fail-closed independent audit by default.",
        args: CompletionClaimArgs,
        execute: async (args, context) => this.completeGoal(context.sessionID, context.directory, args.completionSummary, args.verificationSummary),
      }),
      audit_goal_completion: tool({
        description: "Read the exact auditor prompt that will be used for the focused goal. This does not complete the goal.",
        args: CompletionClaimArgs,
        execute: async (args, context) => {
          const goal = this.focusedGoalOrMessage(context.sessionID);
          if (typeof goal === "string") return goal;
          return auditPrompt(goal, args.completionSummary, args.verificationSummary);
        },
      }),
      report_auditor_progress: tool({
        description: "Auditor-only progress reporting tool for visible Goal X audit status. It records progress and never completes a goal.",
        args: {
          goalId: tool.schema.string().min(1).optional(),
          message: tool.schema.string().min(1),
        },
        execute: async (args, context) => {
          this.refreshStore();
          const goalID = args.goalId ?? this.auditorSessionGoals.get(context.sessionID);
          if (goalID === undefined) return "No audited goal is associated with this auditor session.";
          const goal = this.store.goals.find((candidate) => candidate.id === goalID);
          if (goal === undefined) return `No goal found for auditor progress: ${goalID}`;
          this.recordAuditProgress(goal, "running", args.message, context.sessionID);
          appendLedger(this.paths, { type: "goal_audit_progress_reported", goalId: goal.id, auditorSessionID: context.sessionID, message: args.message });
          return "Audit progress recorded.";
        },
      }),
    };
  }

  private completeTask(sessionID: string, taskID: string, verificationSummary: string): string {
    const taskContext = this.focusedTaskOrMessage(sessionID, taskID);
    if (typeof taskContext === "string") return taskContext;
    if (taskContext.task.status === "complete") return `Task ${taskID} is already complete.\n\n${summarizeGoal(taskContext.goal)}`;
    if (taskContext.task.status === "skipped") return `Task ${taskID} is skipped; revise or unskip the task before completing it.`;
    if (hasPendingSubtasks(taskContext.task)) return `Task ${taskID} has pending subtasks. Complete or skip subtasks before completing the parent task.`;
    if (this.options.strictTaskContracts && taskContext.task.verificationContract !== undefined && verificationSummary.trim().length === 0) {
      return `Task ${taskID} has a verification contract and requires verificationSummary evidence.`;
    }
    const next = this.persistTaskUpdate(sessionID, taskID, taskContext, "goal_task_completed", completeTaskUpdate(verificationSummary));
    return `Task marked complete.\n\n${summarizeGoal(next)}`;
  }

  private skipTask(sessionID: string, taskID: string, reason: string): string {
    const taskContext = this.focusedTaskOrMessage(sessionID, taskID);
    if (typeof taskContext === "string") return taskContext;
    if (reason.trim().length === 0) return "skip_task rejected: reason is required.";
    if (taskContext.task.status === "skipped") return `Task ${taskID} is already skipped.\n\n${summarizeGoal(taskContext.goal)}`;
    if (taskContext.task.status === "complete") return `Task ${taskID} is already complete and cannot be skipped.`;
    const next = this.persistTaskUpdate(sessionID, taskID, taskContext, "goal_task_skipped", skipTaskUpdate(reason));
    return `Task skipped.\n\n${summarizeGoal(next)}`;
  }

  private focusedTaskOrMessage(sessionID: string, taskID: string): FocusedTaskContext | string {
    const taskContext = this.focusedTaskContext(sessionID, taskID);
    if (taskContext.ok === false) return taskContext.message;
    return taskContext.value;
  }

  private persistTaskUpdate(
    sessionID: string,
    taskID: string,
    taskContext: FocusedTaskContext,
    eventType: string,
    updateTask: (task: GoalTask) => GoalTask,
  ): GoalRecord {
    const nextTasks = updateTaskTree(taskContext.taskList.tasks, taskID, updateTask);
    const nextTaskList = { ...taskContext.taskList, tasks: nextTasks };
    return this.persistGoal({ ...taskContext.goal, taskList: nextTaskList, updatedAt: nowIso() }, sessionID, eventType);
  }

  private focusedTaskContext(sessionID: string, taskID: string): OperationResult<FocusedTaskContext> {
    const goalContext = this.focusedGoalContext(sessionID);
    if (goalContext.ok === false) return { ok: false, message: goalContext.message };
    const goal = goalContext.value;
    const taskList = goal.taskList;
    if (taskList === undefined) return { ok: false, message: "No task list is attached to this goal." };
    const task = findTask(taskList.tasks, taskID);
    if (task === undefined) return { ok: false, message: `No task found with id: ${taskID}` };
    return { ok: true, value: { goal, task, taskList } };
  }

  private focusedGoalContext(sessionID: string): OperationResult<GoalRecord> {
    const goal = this.focusedGoalFromFreshStore(sessionID);
    if (goal === undefined) return { ok: false, message: this.noGoalText() };
    return { ok: true, value: goal };
  }

  private focusedGoalOrMessage(sessionID: string): GoalRecord | string {
    const goalContext = this.focusedGoalContext(sessionID);
    if (goalContext.ok === false) return goalContext.message;
    return goalContext.value;
  }

  private activeGoalOrMessage(sessionID: string): GoalRecord | string {
    return this.goalMatchingOrMessage(sessionID, isActiveGoal, (status) => `Goal is not active. Current status: ${status}`);
  }

  private openLifecycleGoalOrMessage(sessionID: string, action: string): GoalRecord | string {
    return this.goalMatchingOrMessage(sessionID, isOpenGoal, (status) => `Cannot ${action} a ${status} goal.`);
  }

  private goalMatchingOrMessage(
    sessionID: string,
    predicate: (goal: GoalRecord) => boolean,
    failureMessage: (status: GoalRecord["status"]) => string,
  ): GoalRecord | string {
    const goal = this.focusedGoalOrMessage(sessionID);
    if (typeof goal === "string") return goal;
    if (predicate(goal) === false) return failureMessage(goal.status);
    return goal;
  }

  private openFocusedGoal(sessionID: string): MaybeUndefined<GoalRecord> {
    return this.focusedGoalMatching(sessionID, isOpenGoal);
  }

  private activeFocusedGoal(sessionID: string): MaybeUndefined<GoalRecord> {
    return this.focusedGoalMatching(sessionID, isActiveGoal);
  }

  private focusedGoalMatching(sessionID: string, predicate: (goal: GoalRecord) => boolean): MaybeUndefined<GoalRecord> {
    const goal = this.focusedGoalFromFreshStore(sessionID);
    if (goal === undefined) return undefined;
    if (predicate(goal) === false) return undefined;
    return goal;
  }

  private focusedGoalFromFreshStore(sessionID: string): MaybeUndefined<GoalRecord> {
    this.refreshStore();
    return focusedGoal(this.store, sessionID);
  }

  private autoContinuingGoal(sessionID: string): MaybeUndefined<GoalRecord> {
    const goal = this.activeFocusedGoal(sessionID);
    if (goal === undefined) return undefined;
    if (goal.autoContinue === false) return undefined;
    return goal;
  }

  private taskValidationOptions(): TaskValidationOptions {
    return {
      maxTaskCount: this.options.maxTaskCount,
      maxSubtaskDepth: this.options.maxSubtaskDepth,
      strictTaskContracts: this.options.strictTaskContracts,
    };
  }

  private goalBudgetOverrides(overrides: MaybeUndefined<Partial<GoalBudget>>): Partial<GoalBudget> {
    const budgetOverrides = overrides ?? {};
    return {
      maxTurns: budgetOverrides.maxTurns ?? this.options.maxTurns,
      maxRuntimeMs: budgetOverrides.maxRuntimeMs ?? this.options.maxRuntimeMs,
      maxTokens: budgetOverrides.maxTokens ?? this.options.maxTokens,
      minDelayMs: budgetOverrides.minDelayMs ?? this.options.minDelayMs,
      noProgressTurnsBeforePause: budgetOverrides.noProgressTurnsBeforePause ?? this.options.noProgressTurnsBeforePause,
      noToolCallTurnsBeforePause: budgetOverrides.noToolCallTurnsBeforePause ?? this.options.noToolCallTurnsBeforePause,
      noProgressTokenThreshold: budgetOverrides.noProgressTokenThreshold ?? this.options.noProgressTokenThreshold,
      maxPromptFailures: budgetOverrides.maxPromptFailures ?? this.options.maxPromptFailures,
    };
  }

  private recordAuditProgress(goal: GoalRecord, status: NonNullable<GoalRecord["auditProgress"]>["status"], message: string, auditorSessionID?: string): NonNullable<GoalRecord["auditProgress"]> {
    if (auditorSessionID !== undefined) this.auditorSessionGoals.set(auditorSessionID, goal.id);
    const progress = { status, message, auditorSessionID, updatedAt: nowIso() };
    this.mergeAuditProgress(goal.id, progress);
    this.persistGoal({ ...goal, auditProgress: progress, updatedAt: nowIso() }, goal.sessionID ?? "audit", "goal_audit_progress");
    return progress;
  }

  private async completeGoal(sessionID: string, directory: string, completionSummary: string, verificationSummary: string): Promise<string> {
    const goal = this.openLifecycleGoalOrMessage(sessionID, "complete");
    if (typeof goal === "string") return goal;
    if (hasPendingBlockingTasks(goal)) return "complete_goal rejected: pending blocking tasks remain.";
    if (goal.verificationContract !== undefined && verificationSummary.trim().length === 0) {
      return "complete_goal rejected: verificationSummary is required by the goal verification contract.";
    }

    if (this.options.requireAudit) {
      await this.toast("Auditing goal completion...", "info");
      this.recordAuditProgress(goal, "starting", "Completion audit started.");
      const audit = await runCompletionAudit({
        client: this.input.client,
        directory,
        parentSessionID: sessionID,
        goal,
        completionSummary,
        verificationSummary,
        options: this.options,
        executionContext: this.executionContextFor(sessionID),
        onProgress: (message, auditorSessionID) => this.recordAuditProgress(goal, "running", message, auditorSessionID),
      });
      if (audit.approved === false) {
        const rejected = updateGoalStatus(goal, "paused", {
          autoContinue: false,
          stopReason: "audit_rejected",
          pauseReason: audit.error ?? "Completion audit rejected the claim.",
          completionSummary,
          verificationSummary,
          audit: auditRecord("rejected", audit.output.length === 0 ? audit.error ?? "Audit rejected." : audit.output, audit),
        });
        const auditProgress = this.recordAuditProgress(rejected, "rejected", audit.error ?? "Completion audit rejected the claim.", audit.auditorSessionID);
        this.persistGoal({ ...rejected, auditProgress }, sessionID, "goal_audit_rejected");
        this.clearContinuation(sessionID);
        return `Goal completion rejected by audit.\n\n${summarizeGoal(rejected)}\n\nAudit output:\n${audit.output || audit.error || "No audit output."}`;
      }

      this.recordAuditProgress(goal, "approved", "Completion audit approved the goal.", audit.auditorSessionID);
      const complete = completeGoalRecord(goal, completionSummary, verificationSummary, auditRecord("approved", audit.output, audit));
      const saved = this.persistAndUnfocus(sessionID, complete, "goal_completed");
      await this.toast("Goal complete.", "success");
      return `Goal complete.\n\n${summarizeGoal(saved)}\n\nAudit output:\n${audit.output}`;
    }

    const complete = completeGoalRecord(goal, completionSummary, verificationSummary, auditRecord("approved", "Audit disabled by configuration.", {}));
    const saved = this.persistAndUnfocus(sessionID, complete, "goal_completed_without_audit");
    return `Goal complete without audit.\n\n${summarizeGoal(saved)}`;
  }

  private persistAndUnfocus(sessionID: string, goal: GoalRecord, eventType: string): GoalRecord {
    const saved = this.persistGoal(goal, sessionID, eventType);
    this.store = focusGoal(this.store, sessionID, undefined);
    saveStore(this.paths, this.store);
    this.clearContinuation(sessionID);
    return saved;
  }

  private sessionPromptInput(sessionID: string, text: string): VariantAwareTextPromptInput {
    return buildVariantAwareTextPrompt({
      sessionID,
      directory: this.input.directory,
      text,
      executionContext: this.executionContextFor(sessionID),
    });
  }

  private async toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
    try {
      await this.input.client.tui.showToast({ body: { title: "opencode-goal-x", message, variant, duration: 5_000 } });
    } catch (error) {
      await this.log("debug", `Could not show toast: ${message}`, { error: errorMessage(error) });
    }
  }

  private runBackgroundTask(task: Promise<void>, failureMessage: string, extra?: UnknownRecord): void {
    task.catch((error: unknown) => {
      this.log("warn", failureMessage, { ...extra, error: errorMessage(error) }).catch((logError: unknown) => {
        console.warn(`[opencode-goal-x] background task log failed: ${errorMessage(logError)}`);
      });
    });
  }

  private async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: UnknownRecord): Promise<void> {
    try {
      await this.input.client.app.log({ body: { service: PLUGIN_NAME, level, message, extra } });
    } catch (error) {
      // Logging must never break the goal loop.
      console.warn(`[opencode-goal-x] log failed: ${errorMessage(error)}`);
    }
  }
}

function handled(text: string, shouldAutoContinue: boolean): CommandExecutionResult {
  return { text, shouldAutoContinue };
}

function isActiveGoal(goal: GoalRecord): boolean {
  return goal.status === "active";
}

function findOpenGoalBySelector(goals: GoalRecord[], selector: string): MaybeUndefined<GoalRecord> {
  const maybeIndex = Number.parseInt(selector, 10);
  if (Number.isInteger(maybeIndex) && String(maybeIndex) === selector) return goals[maybeIndex - 1];
  return goals.find((goal) => goal.id === selector || goal.id.startsWith(selector));
}

function resetGoalRunProgress(goal: GoalRecord): GoalRecord["progress"] {
  return {
    ...goal.progress,
    continuationTurns: 0,
    promptFailures: 0,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    startedAt: Date.now(),
    lastContinuedAt: undefined,
    toolCallsSinceLastContinue: 0,
  };
}

function auditRecord(decision: "approved" | "rejected", summary: string, audit: AuditRecordInput): NonNullable<GoalRecord["audit"]> {
  return {
    decision,
    summary,
    auditorSessionID: audit.auditorSessionID,
    model: audit.model,
    variant: audit.variant,
    createdAt: nowIso(),
  };
}

function completeGoalRecord(goal: GoalRecord, completionSummary: string, verificationSummary: string, audit: NonNullable<GoalRecord["audit"]>): GoalRecord {
  return updateGoalStatus(goal, "complete", {
    autoContinue: false,
    stopReason: "agent",
    completionSummary,
    verificationSummary,
    audit,
  });
}

function completeTaskUpdate(verificationSummary: string): (task: GoalTask) => GoalTask {
  return taskStatusUpdate({
    status: "complete",
    evidence: verificationSummary,
    completedAt: nowIso(),
  });
}

function skipTaskUpdate(reason: string): (task: GoalTask) => GoalTask {
  return taskStatusUpdate({
    status: "skipped",
    skipReason: reason,
    skippedAt: nowIso(),
  });
}

function taskStatusUpdate(updates: Partial<GoalTask>): (task: GoalTask) => GoalTask {
  return (task) => ({ ...task, ...updates });
}

function commandSignature(command: string, rawArguments: string): string {
  return `${command}\u0000${rawArguments}`;
}

function ledgerText(event: UnknownRecord, field: string): MaybeUndefined<string> {
  const value = event[field];
  if (typeof value !== "string") return undefined;
  return value;
}

function isRecentLedgerEvent(event: UnknownRecord, maxAgeMs: number): boolean {
  const at = ledgerText(event, "at");
  if (at === undefined) return false;
  const timestamp = Date.parse(at);
  if (Number.isNaN(timestamp)) return false;
  return Date.now() - timestamp <= maxAgeMs;
}

function helpText(commandName: string): string {
  return [
    "opencode-goal-x commands:",
    `/${commandName} <topic> (draft; requires /${commandName}-confirm before start)`,
    `/${commandName}-set <objective> (immediate start)`,
    `/${commandName}-confirm [draft-id]`,
    `/${commandName}-reject [draft-id]`,
    `/${commandName}-status`,
    `/${commandName}-list`,
    `/${commandName}-focus <number-or-id>`,
    `/${commandName}-pause [reason]`,
    `/${commandName}-resume`,
    `/${commandName}-tweak <new objective>`,
    `/${commandName}-abort [reason]`,
    `/${commandName}-clear`,
    "Flags for start: --max-turns, --max-minutes, --budget, --success, --constraints, --contract.",
  ].join("\n");
}

export function createGoalRuntime(input: PluginInput, rawOptions: unknown = DEFAULT_OPTIONS): GoalRuntime {
  return new GoalRuntime(input, rawOptions);
}
