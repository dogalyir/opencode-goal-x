import type { TuiPluginApi, TuiPluginModule, TuiSlotProps } from "@opencode-ai/plugin/tui";
import { DEFAULT_STATE_DIR, PLUGIN_NAME } from "./defaults";
import { errorMessage } from "./errors";
import { nonBlankStringField } from "./guards";
import { normalizeOpenCodeEvent } from "./opencode-events";
import type { MaybeUndefined, UnknownRecord } from "./types";
import { tuiCommandParameters } from "./tui-command";
import { loadGoalDashboardState, parseTuiStateDir, renderFocusedGoalBadge, renderGoalDashboardText } from "./tui-state";

const DASHBOARD_ROUTE = "goal-x.dashboard";

const GoalXTuiPlugin = {
  id: PLUGIN_NAME,
  tui: async (api, options) => {
    const stateDir = parseTuiStateDir(options);
    const dashboardState = (sessionID?: string) => loadGoalDashboardState({ directory: api.state.path.directory, stateDir, sessionID });

    const unregisterRoute = api.route.register([
      {
        name: DASHBOARD_ROUTE,
        render: (input) => api.ui.DialogAlert({
          title: "Goal X Dashboard",
          message: renderGoalDashboardText(dashboardState(sessionIDFromParams(input.params))),
        }),
      },
    ]);
    api.lifecycle.onDispose(unregisterRoute);

    const slotID = api.slots.register({
      render: (input: TuiSlotProps) => {
        if (input.name !== "session_prompt_right" && input.name !== "sidebar_footer" && input.name !== "app_bottom") return null;
        const sessionID = "session_id" in input && typeof input.session_id === "string" ? input.session_id : undefined;
        return renderFocusedGoalBadge(dashboardState(sessionID));
      },
    });

    const commandApi = api.command;
    if (commandApi !== undefined) {
      const unregisterCommands = commandApi.register(() => [
        {
          title: "Goal X: Open dashboard",
          value: DASHBOARD_ROUTE,
          description: "Show focused goal, open goals, drafts, archives, task progress, and audit status.",
          category: "Goal X",
          slash: { name: "goal-dashboard", aliases: ["goal-x"] },
          onSelect: () => api.route.navigate(DASHBOARD_ROUTE),
        },
        {
          title: "Goal X: Draft a goal",
          value: "goal-x.draft",
          description: "Insert /goal so the server plugin starts the confirmation-first draft flow.",
          category: "Goal X",
          slash: { name: "goal-draft" },
          onSelect: () => api.ui.toast({ title: "Goal X", message: "Run /goal <topic> to draft, or /goal-set <objective> to start immediately.", variant: "info" }),
        },
        {
          title: "Goal X: Confirm draft",
          value: "goal-x.confirm",
          description: "Open a confirmation dialog for the latest server-side draft.",
          category: "Goal X",
          slash: { name: "goal-confirm-draft" },
          onSelect: () => showConfirmDraftDialog(api),
        },
        {
          title: "Goal X: Focus goal",
          value: "goal-x.focus",
          description: "Select an open goal to focus.",
          category: "Goal X",
          slash: { name: "goal-focus-dialog" },
          onSelect: () => showFocusDialog(api, dashboardState()),
        },
        {
          title: "Goal X: Pause focused goal",
          value: "goal-x.pause",
          description: "Prompt for a pause reason and execute /goal-pause.",
          category: "Goal X",
          slash: { name: "goal-pause-dialog" },
          onSelect: () => showPauseDialog(api),
        },
        {
          title: "Goal X: Settings summary",
          value: "goal-x.settings",
          description: "Show effective UI-side Goal X settings and state location.",
          category: "Goal X",
          slash: { name: "goal-settings" },
          onSelect: () => showSettingsDialog(api, stateDir),
        },
        {
          title: "Goal X: Focus/status help",
          value: "goal-x.status-help",
          description: "Show Goal X command shortcuts.",
          category: "Goal X",
          slash: { name: "goal-status-help" },
          onSelect: () => api.ui.toast({ title: "Goal X", message: "Use /goal-status, /goal-list, /goal-focus <id>, /goal-pause, /goal-resume, and /goal-abort.", variant: "info" }),
        },
      ]);
      api.lifecycle.onDispose(unregisterCommands);
    }

    const unsubscribeMessages = api.event.on("message.updated", (event) => {
      const sessionID = sessionIDFromMessageUpdatedEvent(event);
      if (sessionID === undefined) return;
      const state = dashboardState(sessionID);
      const focused = state.focusedGoal;
      if (focused === undefined) return;
      if (focused.auditStatus !== "rejected") return;
      runTuiTask(api.attention.notify({
        title: "Goal X audit rejected",
        message: focused.auditMessage ?? "A completion audit rejected the goal.",
        notification: true,
        sound: { name: "error" },
      }), (error) => showTuiError(api, error));
    });
    api.lifecycle.onDispose(unsubscribeMessages);

    api.ui.toast({ title: "Goal X", message: `TUI plugin loaded (${slotID}).`, variant: "info", duration: 2_000 });
  },
} satisfies TuiPluginModule;

function showConfirmDraftDialog(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Confirm Goal X draft",
    message: "Start the latest pending Goal X draft? The server plugin will create, focus, persist, and auto-continue it.",
    onConfirm: () => executeCommandAfterDialogClear(api, "/goal-confirm"),
    onCancel: () => clearDialog(api),
  }));
}

function showFocusDialog(api: TuiPluginApi, state: ReturnType<typeof loadGoalDashboardState>): void {
  if (state.openGoals.length === 0) {
    api.ui.toast({ title: "Goal X", message: "No open goals to focus.", variant: "info" });
    return;
  }
  api.ui.dialog.replace(() => api.ui.DialogSelect<string>({
    title: "Focus Goal X goal",
    options: state.openGoals.map((goal) => ({
      title: goal.objective,
      value: goal.id,
      description: `${goal.status} ${goal.id}`,
    })),
    onSelect: (option) => executeCommandAfterDialogClear(api, `/goal-focus ${option.value}`),
  }));
}

function showPauseDialog(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => api.ui.DialogPrompt({
    title: "Pause focused Goal X goal",
    placeholder: "Reason for pausing",
    onConfirm: (value) => executeCommandAfterDialogClear(api, `/goal-pause ${pauseReason(value)}`),
    onCancel: () => clearDialog(api),
  }));
}

function showSettingsDialog(api: TuiPluginApi, stateDir: MaybeUndefined<string>): void {
  const stateText = stateDir ?? DEFAULT_STATE_DIR;
  api.ui.dialog.replace(() => api.ui.DialogConfirm({
    title: "Goal X settings",
    message: `Authoritative state: ${stateText}\nServer commands remain authoritative. TUI KV is intentionally not used for goal state.`,
    onConfirm: () => clearDialog(api),
    onCancel: () => clearDialog(api),
  }));
}

function executeCommandAfterDialogClear(api: TuiPluginApi, command: string): void {
  clearDialog(api);
  runTuiTask(executeTuiCommand(api, command), (error) => showTuiError(api, error));
}

function clearDialog(api: TuiPluginApi): void {
  api.ui.dialog.clear();
}

function pauseReason(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Paused from Goal X TUI.";
  return trimmed;
}

async function executeTuiCommand(api: TuiPluginApi, command: string): Promise<void> {
  await api.client.tui.executeCommand(tuiCommandParameters(api.state.path.directory, command));
}

function runTuiTask(task: Promise<unknown>, onError: (error: unknown) => void): void {
  task.catch(onError);
}

function showTuiError(api: TuiPluginApi, error: unknown): void {
  api.ui.toast({ title: "Goal X", message: errorMessage(error), variant: "error" });
}

export function sessionIDFromMessageUpdatedEvent(event: unknown): MaybeUndefined<string> {
  const normalizedEvent = normalizeOpenCodeEvent(event);
  if (normalizedEvent.ok === false) return undefined;
  if (normalizedEvent.value.type !== "message.updated") return undefined;
  return normalizedEvent.value.info.sessionID;
}

function sessionIDFromParams(params: MaybeUndefined<UnknownRecord>): MaybeUndefined<string> {
  if (params === undefined) return undefined;
  return nonBlankStringField(params, "sessionID");
}

export default GoalXTuiPlugin;
