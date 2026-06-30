import type { Event, Message } from "@opencode-ai/sdk";
import { tool, type Config, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import { runCompletionAudit } from "./audit";
import { parseGoalCommand } from "./commands";
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
  nowIso,
  openGoals,
  summarizeGoal,
  updateGoalStatus,
  updateTaskTree,
  upsertGoal,
} from "./goal";
import { auditPrompt, compactionContext, continuationPrompt, goalSystemPrompt, limitWrapUpPrompt } from "./prompts";
import { normalizeOptions } from "./schemas";
import { appendLedger, loadStore, resolveGoalPaths, saveStore, writeGoalMarkdown } from "./storage";
import type {
  CommandExecutionResult,
  GoalBudget,
  GoalPaths,
  GoalRecord,
  GoalRuntimeOptions,
  GoalStoreSnapshot,
  GoalTask,
  GoalTaskList,
  OperationResult,
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
};

const SubtaskInputSchema = tool.schema.object(TaskInputBaseFields);

const TaskInputSchema = tool.schema.object({
  ...TaskInputBaseFields,
  subtasks: tool.schema.array(SubtaskInputSchema).optional(),
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

const TaskIdArg = tool.schema.string().min(1);

const ReasonArgs = {
  reason: tool.schema.string().min(1),
};

interface FocusedTaskContext {
  goal: GoalRecord;
  task: GoalTask;
  taskList: GoalTaskList;
}

interface SessionTextPromptInput {
  path: { id: string };
  query: { directory: string };
  body: { parts: Array<{ type: "text"; text: string }> };
}

export class GoalRuntime {
  private readonly input: PluginInput;
  private readonly options: GoalRuntimeOptions;
  private readonly paths: GoalPaths;
  private store: GoalStoreSnapshot;
  private readonly continuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly continuationInFlight = new Set<string>();
  private readonly lastEvaluatedContinuation = new Map<string, number>();

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
      "command.execute.before": async (input, output) => {
        await this.handleCommand(input.command, input.sessionID, input.arguments, output.parts);
      },
      "experimental.chat.system.transform": async (input, output) => {
        this.appendGoalSystemContext(input.sessionID, output.system);
      },
      "experimental.session.compacting": async (input, output) => {
        this.appendCompactionContext(input.sessionID, output.context);
      },
      "experimental.compaction.autocontinue": async (input, output) => {
        this.disableCompactionAutocontinue(input.sessionID, output);
      },
      "tool.execute.after": async (input, output) => {
        this.trackToolExecution(input.sessionID, input.tool, output.output);
      },
      tool: this.toolDefinitions(),
    };
  }

  private dispose(): void {
    for (const timer of this.continuationTimers.values()) clearTimeout(timer);
    this.continuationTimers.clear();
    this.continuationInFlight.clear();
  }

  private appendGoalSystemContext(sessionID: string | undefined, system: string[]): void {
    if (sessionID === undefined) return;
    const goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) return;
    if (goal.status !== "active" && goal.status !== "paused") return;
    system.push(goalSystemPrompt(goal));
  }

  private appendCompactionContext(sessionID: string, context: string[]): void {
    const goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) return;
    context.push(compactionContext(goal));
  }

  private disableCompactionAutocontinue(sessionID: string, output: { enabled: boolean }): void {
    const queued = this.queueContinuation(sessionID, "post-compaction");
    if (!queued) return;
    output.enabled = false;
  }

  private registerCommands(config: Config): void {
    if (config.command === undefined) config.command = {};
    const commandName = this.options.commandName;
    config.command[commandName] = {
      description: "Start or manage a durable opencode-goal-x objective.",
      template: "$ARGUMENTS",
    };
    config.command[`${commandName}-set`] = {
      description: "Start a durable opencode-goal-x objective immediately.",
      template: "$ARGUMENTS",
    };
    config.command[`${commandName}-status`] = { description: "Show the focused goal status.", template: "$ARGUMENTS" };
    config.command[`${commandName}-list`] = { description: "List open goals.", template: "$ARGUMENTS" };
    config.command[`${commandName}-focus`] = { description: "Focus an open goal by number or id.", template: "$ARGUMENTS" };
    config.command[`${commandName}-pause`] = { description: "Pause the focused goal.", template: "$ARGUMENTS" };
    config.command[`${commandName}-resume`] = { description: "Resume the focused paused goal.", template: "$ARGUMENTS" };
    config.command[`${commandName}-tweak`] = { description: "Revise the focused goal objective.", template: "$ARGUMENTS" };
    config.command[`${commandName}-abort`] = { description: "Abort and archive the focused goal.", template: "$ARGUMENTS" };
    config.command[`${commandName}-clear`] = { description: "Clear and archive the focused goal.", template: "$ARGUMENTS" };
  }

  private async handleCommand(command: string, sessionID: string, rawArguments: string, parts: { type: string; text?: string }[]): Promise<void> {
    if (!this.ownsCommand(command)) return;
    const parsed = parseGoalCommand(command, this.options.commandName, rawArguments);
    if (!parsed.ok) {
      this.replaceCommandText(parts, `opencode-goal-x command rejected: ${parsed.message}`);
      await this.toast(parsed.message, "error");
      return;
    }

    const result = await this.executeParsedCommand(sessionID, parsed.value);
    this.replaceCommandText(parts, result.text);
    await this.toast(result.text.split("\n")[0] ?? "opencode-goal-x", "info");
    if (result.shouldAutoContinue) this.queueContinuation(sessionID, "command");
  }

  private ownsCommand(command: string): boolean {
    const base = this.options.commandName;
    return command === base || command.startsWith(`${base}-`);
  }

  private replaceCommandText(parts: { type: string; text?: string }[], text: string): void {
    for (const part of parts) {
      if (part.type !== "text") continue;
      part.text = text;
      return;
    }
  }

  private async executeParsedCommand(sessionID: string, command: { action: string; objective?: string; goalId?: string; reason?: string; successCriteria?: string; constraints?: string; verificationContract?: string; budgetOverrides: Partial<GoalBudget> }): Promise<CommandExecutionResult> {
    if (command.action === "start") {
      if (command.objective === undefined) return handled("Goal objective is empty.", false);
      const goal = createGoal({
        objective: command.objective,
        sessionID,
        autoContinue: true,
        budgetOverrides: command.budgetOverrides,
        successCriteria: command.successCriteria,
        constraints: command.constraints,
        verificationContract: command.verificationContract,
      });
      const saved = this.persistGoal(goal, sessionID, "goal_started");
      return handled(`Goal started.\n\n${summarizeGoal(saved)}\n\nThe auto-continue loop is armed.`, true);
    }

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

  private focusGoalCommand(sessionID: string, selector: string | undefined): string {
    const goals = openGoals(this.store);
    if (goals.length === 0) return "No open goals to focus.";
    if (selector === undefined || selector.trim().length === 0) return formatGoalList(this.store, sessionID);
    const trimmed = selector.trim();
    const maybeIndex = Number.parseInt(trimmed, 10);
    const goal = Number.isInteger(maybeIndex) && String(maybeIndex) === trimmed
      ? goals[maybeIndex - 1]
      : goals.find((candidate) => candidate.id === trimmed || candidate.id.startsWith(trimmed));
    if (goal === undefined) return `No open goal matches: ${trimmed}`;
    this.store = focusGoal(this.store, sessionID, goal.id);
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: "goal_focused", goalId: goal.id, sessionID });
    return `Focused goal ${goal.id}.\n\n${summarizeGoal(goal)}`;
  }

  private pauseFocusedGoal(sessionID: string, reason: string, stopReason: "user" | "agent"): string {
    const goalContext = this.focusedGoalContext(sessionID);
    if (!goalContext.ok) return goalContext.message;
    const goal = goalContext.value;
    if (goal.status !== "active") return `Goal is not active. Current status: ${goal.status}`;
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
    const goalContext = this.focusedGoalContext(sessionID);
    if (!goalContext.ok) return goalContext.message;
    const goal = goalContext.value;
    if (goal.status !== "active" && goal.status !== "paused") return `Cannot tweak a ${goal.status} goal.`;
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
    const goalContext = this.focusedGoalContext(sessionID);
    if (!goalContext.ok) return goalContext.message;
    const goal = goalContext.value;
    const next = updateGoalStatus(goal, "aborted", {
      autoContinue: false,
      stopReason: "user",
      abortReason: reason,
    });
    const saved = this.persistAndUnfocus(sessionID, next, "goal_aborted");
    return `Goal aborted.\n\n${summarizeGoal(saved)}`;
  }

  private noGoalText(): string {
    return `No focused goal. Use /${this.options.commandName} <objective> to start one.`;
  }

  private persistGoal(goal: GoalRecord, sessionID: string, eventType: string): GoalRecord {
    const saved = writeGoalMarkdown(this.paths, { ...cloneGoal(goal), updatedAt: nowIso() });
    this.store = upsertGoal(this.store, saved);
    if (saved.status === "active" || saved.status === "paused") this.store = focusGoal(this.store, sessionID, saved.id);
    saveStore(this.paths, this.store);
    appendLedger(this.paths, { type: eventType, goalId: saved.id, sessionID, status: saved.status });
    return saved;
  }

  private async handleEvent(event: Event): Promise<void> {
    if (event.type === "session.idle") {
      await this.handleIdle(event.properties.sessionID);
      return;
    }
    if (event.type === "session.compacted") {
      this.queueContinuation(event.properties.sessionID, "compacted");
      return;
    }
    if (event.type === "message.updated") {
      this.trackAssistantMessage(event.properties.info);
    }
  }

  private trackAssistantMessage(message: Message): void {
    if (message.role !== "assistant") return;
    const goal = this.activeFocusedGoal(message.sessionID);
    if (goal === undefined) return;
    const tokenTotal = message.tokens.input + message.tokens.output + message.tokens.reasoning;
    const next = {
      ...goal,
      progress: {
        ...goal.progress,
        tokensUsed: Math.max(goal.progress.tokensUsed, tokenTotal),
        lastAssistantOutputTokens: message.tokens.output,
      },
      updatedAt: nowIso(),
    };
    this.persistGoal(next, message.sessionID, "goal_accounted");
  }

  private trackToolExecution(sessionID: string, toolName: string, toolOutput: string): void {
    const goal = this.activeFocusedGoal(sessionID);
    if (goal === undefined) return;
    if (!MEANINGFUL_PROGRESS_TOOLS.has(toolName)) return;
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

  private guardReason(goal: GoalRecord): string | undefined {
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
      void this.sendContinuation(sessionID, reason);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.continuationTimers.set(sessionID, timer);
    return true;
  }

  private clearContinuation(sessionID: string): void {
    const timer = this.continuationTimers.get(sessionID);
    if (timer !== undefined) clearTimeout(timer);
    this.continuationTimers.delete(sessionID);
    this.continuationInFlight.delete(sessionID);
  }

  private async sendContinuation(sessionID: string, reason: string): Promise<void> {
    const goal = this.autoContinuingGoal(sessionID);
    if (goal === undefined) return;
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
    void this.log("warn", `Goal continuation prompt failed: ${message}`, { goalId: goal.id, sessionID });
    const guardReason = this.guardReason(next);
    if (guardReason === undefined) return;
    void this.pauseForLimit(sessionID, next, guardReason);
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
          const goalContext = this.focusedGoalContext(context.sessionID);
          if (!goalContext.ok) return goalContext.message;
          return summarizeGoal(goalContext.value);
        },
      }),
      propose_goal_draft: tool({
        description: "Propose or create a durable goal. Only create when the user explicitly asked to start this exact goal.",
        args: {
          objective: tool.schema.string().min(1),
          successCriteria: tool.schema.string().min(1).optional(),
          constraints: tool.schema.string().min(1).optional(),
          verificationContract: tool.schema.string().min(1).optional(),
          confirmUserIntent: tool.schema.boolean().describe("Set true only when the user explicitly asked to start this exact goal now."),
        },
        execute: async (args, context) => {
          if (!args.confirmUserIntent) {
            return [
              "Goal draft ready. Ask the user to confirm or run /goal-set with this objective.",
              "",
              args.objective,
            ].join("\n");
          }
          const goal = createGoal({
            objective: args.objective,
            sessionID: context.sessionID,
            autoContinue: true,
            successCriteria: args.successCriteria,
            constraints: args.constraints,
            verificationContract: args.verificationContract,
          });
          const saved = this.persistGoal(goal, context.sessionID, "goal_created_by_tool");
          this.queueContinuation(context.sessionID, "tool");
          return `Goal confirmed and started.\n\n${summarizeGoal(saved)}`;
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
          const parsed = taskListInputSchema.safeParse(args);
          if (!parsed.success) return "Task list rejected: invalid task shape.";
          const validation = validateTaskIds(parsed.data.tasks);
          if (!validation.ok) return validation.message;
          const goal = focusedGoal(this.store, context.sessionID);
          if (goal === undefined) return this.noGoalText();
          const taskList: GoalTaskList = {
            tasks: parsed.data.tasks,
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
          const goalContext = this.focusedGoalContext(context.sessionID);
          if (!goalContext.ok) return goalContext.message;
          return auditPrompt(goalContext.value, args.completionSummary, args.verificationSummary);
        },
      }),
    };
  }

  private completeTask(sessionID: string, taskID: string, verificationSummary: string): string {
    const taskContext = this.focusedTaskContext(sessionID, taskID);
    if (!taskContext.ok) return taskContext.message;
    if (hasOpenSubtasks(taskContext.value.task)) return `Task ${taskID} has pending subtasks. Complete or skip subtasks before completing the parent task.`;
    const next = this.persistTaskUpdate(sessionID, taskID, taskContext.value, "goal_task_completed", completeTaskUpdate(verificationSummary));
    return `Task marked complete.\n\n${summarizeGoal(next)}`;
  }

  private skipTask(sessionID: string, taskID: string, reason: string): string {
    const taskContext = this.focusedTaskContext(sessionID, taskID);
    if (!taskContext.ok) return taskContext.message;
    const next = this.persistTaskUpdate(sessionID, taskID, taskContext.value, "goal_task_skipped", skipTaskUpdate(reason));
    return `Task skipped.\n\n${summarizeGoal(next)}`;
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
    if (!goalContext.ok) return { ok: false, message: goalContext.message };
    const goal = goalContext.value;
    const taskList = goal.taskList;
    if (taskList === undefined) return { ok: false, message: "No task list is attached to this goal." };
    const task = findTask(taskList.tasks, taskID);
    if (task === undefined) return { ok: false, message: `No task found with id: ${taskID}` };
    return { ok: true, value: { goal, task, taskList } };
  }

  private focusedGoalContext(sessionID: string): OperationResult<GoalRecord> {
    const goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) return { ok: false, message: this.noGoalText() };
    return { ok: true, value: goal };
  }

  private activeFocusedGoal(sessionID: string): GoalRecord | undefined {
    const goal = focusedGoal(this.store, sessionID);
    if (goal === undefined) return undefined;
    if (goal.status !== "active") return undefined;
    return goal;
  }

  private autoContinuingGoal(sessionID: string): GoalRecord | undefined {
    const goal = this.activeFocusedGoal(sessionID);
    if (goal === undefined) return undefined;
    if (!goal.autoContinue) return undefined;
    return goal;
  }

  private async completeGoal(sessionID: string, directory: string, completionSummary: string, verificationSummary: string): Promise<string> {
    const goalContext = this.focusedGoalContext(sessionID);
    if (!goalContext.ok) return goalContext.message;
    const goal = goalContext.value;
    if (goal.status !== "active" && goal.status !== "paused") return `Cannot complete a ${goal.status} goal.`;
    if (hasPendingBlockingTasks(goal)) return "complete_goal rejected: pending blocking tasks remain.";
    if (goal.verificationContract !== undefined && verificationSummary.trim().length === 0) {
      return "complete_goal rejected: verificationSummary is required by the goal verification contract.";
    }

    if (this.options.requireAudit) {
      await this.toast("Auditing goal completion...", "info");
      const audit = await runCompletionAudit({
        client: this.input.client,
        directory,
        parentSessionID: sessionID,
        goal,
        completionSummary,
        verificationSummary,
        options: this.options,
      });
      if (!audit.approved) {
        const rejected = updateGoalStatus(goal, "paused", {
          autoContinue: false,
          stopReason: "audit_rejected",
          pauseReason: audit.error ?? "Completion audit rejected the claim.",
          completionSummary,
          verificationSummary,
          audit: auditRecord("rejected", audit.output.length === 0 ? audit.error ?? "Audit rejected." : audit.output, audit),
        });
        this.persistGoal(rejected, sessionID, "goal_audit_rejected");
        this.clearContinuation(sessionID);
        return `Goal completion rejected by audit.\n\n${summarizeGoal(rejected)}\n\nAudit output:\n${audit.output || audit.error || "No audit output."}`;
      }

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

  private sessionPromptInput(sessionID: string, text: string): SessionTextPromptInput {
    return {
      path: { id: sessionID },
      query: { directory: this.input.directory },
      body: { parts: [{ type: "text", text }] },
    };
  }

  private async toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
    try {
      await this.input.client.tui.showToast({ body: { title: "opencode-goal-x", message, variant, duration: 5_000 } });
    } catch (error) {
      await this.log("debug", `Could not show toast: ${message}`, { error: errorMessage(error) });
    }
  }

  private async log(level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>): Promise<void> {
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

function auditRecord(decision: "approved" | "rejected", summary: string, audit: { auditorSessionID?: string; model?: string }): NonNullable<GoalRecord["audit"]> {
  return {
    decision,
    summary,
    auditorSessionID: audit.auditorSessionID,
    model: audit.model,
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

function helpText(commandName: string): string {
  return [
    "opencode-goal-x commands:",
    `/${commandName} <objective>`,
    `/${commandName}-set <objective>`,
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

function validateTaskIds(tasks: GoalTask[]): OperationResult<void> {
  const seen = new Set<string>();
  for (const task of tasks) {
    const duplicate = collectTaskIds(task, seen);
    if (duplicate !== undefined) return { ok: false, message: `Task list rejected: duplicate task id ${duplicate}.` };
  }
  return { ok: true, value: undefined };
}

function collectTaskIds(task: GoalTask, seen: Set<string>): string | undefined {
  if (seen.has(task.id)) return task.id;
  seen.add(task.id);
  if (task.subtasks === undefined) return undefined;
  for (const subtask of task.subtasks) {
    const duplicate = collectTaskIds(subtask, seen);
    if (duplicate !== undefined) return duplicate;
  }
  return undefined;
}

function hasOpenSubtasks(task: GoalTask): boolean {
  if (task.subtasks === undefined) return false;
  for (const subtask of task.subtasks) {
    if (subtask.status === "pending") return true;
    if (hasOpenSubtasks(subtask)) return true;
  }
  return false;
}

export function createGoalRuntime(input: PluginInput, rawOptions: unknown = DEFAULT_OPTIONS): GoalRuntime {
  return new GoalRuntime(input, rawOptions);
}
