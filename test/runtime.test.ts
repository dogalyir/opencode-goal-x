import { describe, expect, test } from "bun:test";
import { createOpencodeClient, type Part } from "@opencode-ai/sdk";
import { tool, type Config, type Hooks, type PluginInput } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin/tool";
import { focusGoal } from "../src/goal";
import { createGoalRuntime } from "../src/runtime";
import { loadStore, resolveGoalPaths, saveStore, writeGoalMarkdown } from "../src/storage";
import type { UnknownRecord } from "../src/types";
import { requireDefined } from "./assertions";
import { makeTempDir } from "./temp-dir";

describe("GoalRuntime integration-style behavior", () => {
  test("/goal creates only planning draft and /goal-confirm refuses it before propose_goal_draft", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const commandHook = requireCommandHook(setup.hooks);
    const parts = textParts();

    await commandHook({ command: "goal", sessionID: "s1", arguments: "draft a verified change" }, { parts });
    const afterDraft = loadStore(setup.paths);

    expect(afterDraft.goals).toHaveLength(0);
    const draft = firstDraft(afterDraft);
    expect(draft.status).toBe("planning");

    await commandHook({ command: "goal-confirm", sessionID: "s1", arguments: "" }, { parts });
    const afterConfirmAttempt = loadStore(setup.paths);

    expect(firstText(parts)).toContain("No finalized goal draft");
    expect(afterConfirmAttempt.goals).toHaveLength(0);
    await setup.runtime.disposeForTest();
  });

  test("duplicate /goal command hooks do not create duplicate planning drafts", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const commandHook = requireCommandHook(setup.hooks);
    const firstParts = textParts();
    const secondParts = textParts();

    await commandHook({ command: "goal", sessionID: "s1", arguments: "draft once" }, { parts: firstParts });
    await commandHook({ command: "goal", sessionID: "s1", arguments: "draft once" }, { parts: secondParts });
    const store = loadStore(setup.paths);

    expect(Object.values(store.drafts ?? {})).toHaveLength(1);
    expect(firstText(secondParts)).toContain("Goal drafting started");
    await setup.runtime.disposeForTest();
  });

  test("plural /goals alias is registered and creates a confirmable draft flow", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const commandHook = requireCommandHook(setup.hooks);
    const configHook = requireConfigHook(setup.hooks);
    const config: Config = {};
    const parts = textParts();

    await configHook(config);
    expect(config.command?.goals).toBeDefined();
    expect(config.command?.["goals-confirm"]).toBeDefined();

    await commandHook({ command: "goals", sessionID: "s1", arguments: "draft from plural alias" }, { parts });
    const afterDraft = loadStore(setup.paths);
    expect(firstDraft(afterDraft).status).toBe("planning");

    const proposeDraft = requireTool(setup.hooks, "propose_goal_draft");
    await proposeDraft.execute({ objective: "draft from plural alias" }, toolContext(setup.directory));
    await commandHook({ command: "goals-confirm", sessionID: "s1", arguments: "" }, { parts });

    const store = loadStore(setup.paths);
    expect(firstText(parts)).toContain("Goal draft confirmed");
    expect(store.goals).toHaveLength(1);
    await setup.runtime.disposeForTest();
  });

  test("propose_goal_draft creates a finalized draft that /goal-confirm starts", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const proposeDraft = requireTool(setup.hooks, "propose_goal_draft");
    const commandHook = requireCommandHook(setup.hooks);

    const draftText = await proposeDraft.execute({ objective: "Finalize and verify a change" }, toolContext(setup.directory));
    expect(String(draftText)).toContain("Show this confirmation to the user");
    expect(String(draftText)).toContain("No goal has been created yet");

    const parts = textParts();
    await commandHook({ command: "goal-confirm", sessionID: "s1", arguments: "" }, { parts });
    const store = loadStore(setup.paths);

    const goal = goalAt(store, 0);
    expect(firstText(parts)).toContain("Goal draft confirmed");
    expect(store.goals).toHaveLength(1);
    expect(goal.status).toBe("active");
    expect(store.focusBySession.s1).toBe(goal.id);
    await setup.runtime.disposeForTest();
  });

  test("duplicate /goal-confirm for the same draft remains successful and creates one goal", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const proposeDraft = requireTool(setup.hooks, "propose_goal_draft");
    const commandHook = requireCommandHook(setup.hooks);

    await proposeDraft.execute({ objective: "Confirm only once" }, toolContext(setup.directory));
    const draftID = firstDraft(loadStore(setup.paths)).id;
    const firstParts = textParts();
    const secondParts = textParts();

    await commandHook({ command: "goal-confirm", sessionID: "s1", arguments: draftID }, { parts: firstParts });
    await commandHook({ command: "goal-confirm", sessionID: "s1", arguments: `${draftID} ` }, { parts: secondParts });
    const store = loadStore(setup.paths);

    expect(firstText(firstParts)).toContain("Goal draft confirmed");
    expect(firstText(secondParts)).toContain("Goal draft already confirmed");
    expect(store.goals).toHaveLength(1);
    await setup.runtime.disposeForTest();
  });

  test("command-origin chat message does not pause a newly confirmed goal", async () => {
    const setup = createRuntimeSetup({ requireAudit: false, minDelayMs: 60_000 });
    const proposeDraft = requireTool(setup.hooks, "propose_goal_draft");
    const commandHook = requireCommandHook(setup.hooks);
    const chatHook = requireChatHook(setup.hooks);

    await proposeDraft.execute({ objective: "Stay active after confirm" }, toolContext(setup.directory));
    await commandHook({ command: "goal-confirm", sessionID: "s1", arguments: "" }, { parts: textParts() });
    await chatHook({ sessionID: "s1" }, {
      message: {
        id: "confirm-message",
        sessionID: "s1",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: "mock-provider", modelID: "mock-model" },
      },
      parts: textParts(),
    });
    const store = loadStore(setup.paths);
    const goal = goalAt(store, 0);

    expect(goal.status).toBe("active");
    await setup.runtime.disposeForTest();
  });

  test("/goal-set creates, focuses, persists, and arms immediate goal state", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });
    const commandHook = requireCommandHook(setup.hooks);
    const parts = textParts();

    await commandHook({ command: "goal-set", sessionID: "s1", arguments: "ship a tiny fix --max-turns 2" }, { parts });
    const store = loadStore(setup.paths);

    const goal = goalAt(store, 0);
    expect(firstText(parts)).toContain("Goal started immediately");
    expect(store.goals).toHaveLength(1);
    expect(goal.objective).toBe("ship a tiny fix");
    expect(goal.budget.maxTurns).toBe(2);
    expect(goal.autoContinue).toBe(true);
    expect(store.focusBySession.s1).toBe(goal.id);
    expect(goal.activePath).toBeDefined();
    await setup.runtime.disposeForTest();
  });

  test("complete_goal blocks pending task lists before audit", async () => {
    const setup = createRuntimeSetup({ requireAudit: true });
    await startImmediateGoal(setup);
    const proposeTasks = requireTool(setup.hooks, "propose_task_list");
    const completeGoal = requireTool(setup.hooks, "complete_goal");

    await proposeTasks.execute({ tasks: [{ id: "tests", title: "Run tests", status: "pending" }] }, toolContext(setup.directory));
    const result = await completeGoal.execute({ completionSummary: "done", verificationSummary: "verified" }, toolContext(setup.directory));

    expect(String(result)).toContain("pending blocking tasks remain");
    const store = loadStore(setup.paths);
    const goal = goalAt(store, 0);
    expect(goal.status).toBe("active");
    expect(goal.audit).toBeUndefined();
    await setup.runtime.disposeForTest();
  });

  test("task tool schemas serialize without OpenAI-rejected refs", async () => {
    const setup = createRuntimeSetup({ requireAudit: false });

    const draftParameters = toolParametersJson(setup.hooks, "propose_goal_draft");
    const taskParameters = toolParametersJson(setup.hooks, "propose_task_list");

    expectNoSchemaRefs(draftParameters);
    expectNoSchemaRefs(taskParameters);
    await setup.runtime.disposeForTest();
  });

  test("complete_goal audit rejection pauses the goal with visible audit record", async () => {
    const setup = createRuntimeSetup({ requireAudit: true });
    await startImmediateGoal(setup);
    const completeGoal = requireTool(setup.hooks, "complete_goal");

    const result = await completeGoal.execute({ completionSummary: "done", verificationSummary: "weak evidence" }, toolContext(setup.directory));
    const store = loadStore(setup.paths);
    const goal = goalAt(store, 0);
    const audit = requireDefined(goal.audit, "goal audit");
    const auditProgress = requireDefined(goal.auditProgress, "goal audit progress");

    expect(String(result)).toContain("Goal completion rejected by audit");
    expect(goal.status).toBe("paused");
    expect(goal.stopReason).toBe("audit_rejected");
    expect(audit.decision).toBe("rejected");
    expect(auditProgress.status).toBe("rejected");
    await setup.runtime.disposeForTest();
  });

  test("prompt failure guard pauses the runtime after a failed continuation", async () => {
    const mockState = mockServerState("error");
    const setup = createRuntimeSetup({ requireAudit: false, minDelayMs: 0, maxPromptFailures: 1 }, mockState);

    await startImmediateGoal(setup);
    await waitForGoalStatus(setup, "paused");
    const store = loadStore(setup.paths);

    const goal = goalAt(store, 0);
    expect(mockState.promptRequests).toBeGreaterThan(0);
    expect(goal.stopReason).toBe("limit");
    expect(goal.pauseReason).toContain("prompt failures");
    await setup.runtime.disposeForTest();
  });

  test("stale queued continuation is ignored when focus changes before the timer fires", async () => {
    const mockState = mockServerState("ok");
    const setup = createRuntimeSetup({ requireAudit: false, minDelayMs: 25 }, mockState);
    const commandHook = requireCommandHook(setup.hooks);

    await commandHook({ command: "goal-set", sessionID: "s1", arguments: "first goal" }, { parts: textParts() });
    await commandHook({ command: "goal-set", sessionID: "s1", arguments: "second goal" }, { parts: textParts() });
    await sleep(80);
    const store = loadStore(setup.paths);

    const firstGoal = goalAt(store, 0);
    const secondGoal = goalAt(store, 1);
    expect(mockState.promptRequests).toBe(0);
    expect(store.goals).toHaveLength(2);
    expect(firstGoal.progress.continuationTurns).toBe(0);
    expect(secondGoal.progress.continuationTurns).toBe(0);
    expect(store.focusBySession.s1).toBe(secondGoal.id);
    await setup.runtime.disposeForTest();
  });

  test("session.idle pauses after a no-tool continuation guard trip", async () => {
    const setup = createRuntimeSetup({ requireAudit: false, noToolCallTurnsBeforePause: 1, minDelayMs: 60_000 });
    await startImmediateGoal(setup);
    const store = loadStore(setup.paths);
    const goal = store.goals[0];
    if (goal === undefined) throw new Error("goal missing");
    const guardedGoal = {
      ...goal,
      progress: {
        ...goal.progress,
        lastContinuedAt: Date.now() - 10_000,
        toolCallsSinceLastContinue: 0,
        lastAssistantOutputTokens: 0,
        noToolCallTurns: 1,
      },
    };
    const savedGuardedGoal = writeGoalMarkdown(setup.paths, guardedGoal);
    saveStore(setup.paths, { ...store, goals: [savedGuardedGoal], focusBySession: { s1: goal.id } });

    const eventHook = requireEventHook(setup.hooks);
    await eventHook({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    const afterIdle = loadStore(setup.paths);

    const goalAfterIdle = goalAt(afterIdle, 0);
    expect(goalAfterIdle.status).toBe("paused");
    expect(goalAfterIdle.stopReason).toBe("limit");
    expect(goalAfterIdle.pauseReason).toContain("no tools");
    await setup.runtime.disposeForTest();
  });
});

interface RuntimeSetup {
  directory: string;
  paths: ReturnType<typeof resolveGoalPaths>;
  runtime: ReturnType<typeof createGoalRuntime> & { disposeForTest(): Promise<void> };
  hooks: Hooks;
}

interface MockServerState {
  promptResponse: "reject" | "error" | "ok";
  promptRequests: number;
}

function createRuntimeSetup(options: UnknownRecord, serverState = mockServerState("reject")): RuntimeSetup {
  const directory = makeTempDir("goal-x-runtime-");
  const runtime = createGoalRuntime(pluginInput(directory, serverState), {
    stateDir: ".opencode/goals",
    minDelayMs: 60_000,
    auditTimeoutMs: 5_000,
    ...options,
  });
  const hooks = runtime.hooks();
  return {
    directory,
    paths: resolveGoalPaths(directory, ".opencode/goals"),
    runtime: Object.assign(runtime, { disposeForTest: () => disposeHooks(hooks) }),
    hooks,
  };
}

function pluginInput(directory: string, serverState: MockServerState): PluginInput {
  const client = createOpencodeClient({ baseUrl: "http://goal-x.test", fetch: mockFetch(directory, serverState) });
  return {
    client,
    project: { id: "project-1", worktree: directory, time: { created: Date.now() } },
    directory,
    worktree: directory,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://goal-x.test"),
    $: Bun.$,
  } satisfies PluginInput;
}

function mockServerState(promptResponse: MockServerState["promptResponse"]): MockServerState {
  return { promptResponse, promptRequests: 0 };
}

function firstDraft(store: ReturnType<typeof loadStore>) {
  return requireDefined(Object.values(store.drafts ?? {})[0], "draft");
}

function goalAt(store: ReturnType<typeof loadStore>, index: number) {
  return requireDefined(store.goals[index], `goal ${index}`);
}

async function disposeHooks(hooks: Hooks): Promise<void> {
  const dispose = hooks.dispose;
  if (dispose === undefined) return;
  await dispose();
}

function mockFetch(directory: string, serverState: MockServerState): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/session") return jsonResponse(sessionPayload("audit-session", directory));
    if (url.pathname.endsWith("/message")) {
      serverState.promptRequests += 1;
      if (serverState.promptResponse === "error") return jsonResponse({ name: "BadRequest", data: { message: "prompt failed" } }, 500);
      if (serverState.promptResponse === "ok") return jsonResponse(assistantPromptPayload("Continuation completed."));
      return jsonResponse(assistantPromptPayload("Audit says no.\n<rejected/>"));
    }
    if (url.pathname === "/tui/show-toast") return jsonResponse(true);
    if (url.pathname === "/app/log") return jsonResponse(true);
    return jsonResponse(true);
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function sessionPayload(id: string, directory: string): UnknownRecord {
  return {
    id,
    projectID: "project-1",
    directory,
    title: "Audit",
    version: "1",
    time: { created: Date.now(), updated: Date.now() },
  };
}

function assistantPromptPayload(text: string): UnknownRecord {
  return {
    info: {
      id: "assistant-1",
      sessionID: "s1",
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: "user-1",
      modelID: "mock-model",
      providerID: "mock-provider",
      mode: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ type: "text", text }],
  };
}

function textParts(): Part[] {
  return [{ id: "part-1", sessionID: "s1", messageID: "m1", type: "text", text: "", time: { start: Date.now() } }];
}

function firstText(parts: Part[]): string {
  const first = parts[0];
  if (first === undefined) throw new Error("missing text part");
  if (first.type !== "text") throw new Error("first part is not text");
  return first.text;
}

function toolContext(directory: string): ToolContext {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {},
  } satisfies ToolContext;
}

function requireCommandHook(hooks: Hooks): NonNullable<Hooks["command.execute.before"]> {
  const hook = hooks["command.execute.before"];
  if (hook === undefined) throw new Error("command hook missing");
  return hook;
}

function requireChatHook(hooks: Hooks): NonNullable<Hooks["chat.message"]> {
  const hook = hooks["chat.message"];
  if (hook === undefined) throw new Error("chat hook missing");
  return hook;
}

function requireConfigHook(hooks: Hooks): NonNullable<Hooks["config"]> {
  const hook = hooks.config;
  if (hook === undefined) throw new Error("config hook missing");
  return hook;
}

function requireEventHook(hooks: Hooks): NonNullable<Hooks["event"]> {
  const hook = hooks.event;
  if (hook === undefined) throw new Error("event hook missing");
  return hook;
}

function requireTool(hooks: Hooks, name: string): NonNullable<NonNullable<Hooks["tool"]>[string]> {
  const tools = hooks.tool;
  if (tools === undefined) throw new Error("tools missing");
  const selected = tools[name];
  if (selected === undefined) throw new Error(`tool missing: ${name}`);
  return selected;
}

function toolParametersJson(hooks: Hooks, name: string): unknown {
  return tool.schema.toJSONSchema(tool.schema.object(requireTool(hooks, name).args));
}

function expectNoSchemaRefs(parameters: unknown): void {
  const serialized = JSON.stringify(parameters);
  expect(serialized).not.toContain('"$ref"');
  expect(serialized).not.toContain('"$defs"');
  expect(serialized).not.toContain('"definitions"');
}

async function startImmediateGoal(setup: RuntimeSetup): Promise<void> {
  const commandHook = requireCommandHook(setup.hooks);
  await commandHook({ command: "goal-set", sessionID: "s1", arguments: "ship runtime behavior" }, { parts: textParts() });
  const store = loadStore(setup.paths);
  const goal = store.goals[0];
  if (goal === undefined) throw new Error("goal was not started");
  saveStore(setup.paths, focusGoal(store, "s1", goal.id));
}

async function waitForGoalStatus(setup: RuntimeSetup, status: "active" | "paused" | "complete" | "aborted"): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1_000) {
    const store = loadStore(setup.paths);
    const goal = store.goals[0];
    if (goal !== undefined && goal.status === status) return;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for goal status ${status}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
