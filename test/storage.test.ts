import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createEmptyStore, createGoal, focusGoal, updateGoalStatus, upsertGoal } from "../src/goal";
import { appendLedger, loadStore, readLedgerEvents, resolveGoalPaths, saveStore, writeGoalMarkdown } from "../src/storage";
import type { GoalPaths, GoalRecord } from "../src/types";
import { makeTempDir } from "./temp-dir";

describe("goal storage", () => {
  test("persists state and active markdown mirror", () => {
    const setup = createStoredGoal("Build the thing");

    const loadedGoal = firstLoadedGoal(setup);
    expect(loadedGoal.objective).toBe("Build the thing");
    expect(loadedGoal.activePath).toBe(setup.goal.activePath);
    expect(activePathExists(setup.goal)).toBe(true);
  });

  test("recovers edited objective from markdown goal prompt", () => {
    const setup = createStoredGoal("Original objective");

    if (setup.goal.activePath === undefined) throw new Error("activePath missing");
    const content = fs.readFileSync(setup.goal.activePath, "utf8");
    const promptStart = content.indexOf("# Goal Prompt");
    const beforePrompt = content.slice(0, promptStart);
    const promptAndAfter = content.slice(promptStart).replace("Original objective", "Edited objective");
    fs.writeFileSync(setup.goal.activePath, `${beforePrompt}${promptAndAfter}`);

    const loadedGoal = firstLoadedGoal(setup);
    expect(loadedGoal.objective).toBe("Edited objective");
  });

  test("archives completed goals and removes active file", () => {
    const setup = createStoredGoal("Finish");
    const active = setup.goal;
    if (active.activePath === undefined) throw new Error("activePath missing");
    const completed = writeGoalMarkdown(setup.paths, updateGoalStatus(active, "complete", { autoContinue: false }));

    expect(fs.existsSync(active.activePath)).toBe(false);
    expect(archivedPathExists(completed)).toBe(true);
  });

  test("reconciliation does not resurrect externally deleted active markdown", () => {
    const setup = createStoredGoal("Delete me externally");
    if (setup.goal.activePath === undefined) throw new Error("activePath missing");
    fs.rmSync(setup.goal.activePath);

    const loaded = loadStore(setup.paths);

    expect(loaded.goals).toHaveLength(0);
    expect(loaded.focusBySession.s1).toBeUndefined();
  });

  test("reconciliation treats externally archived active markdown as closed", () => {
    const setup = createStoredGoal("Archive me externally");
    if (setup.goal.activePath === undefined) throw new Error("activePath missing");
    const archivedPath = path.join(setup.paths.archiveDir, path.basename(setup.goal.activePath));
    fs.renameSync(setup.goal.activePath, archivedPath);

    const loaded = loadStore(setup.paths);
    const loadedGoal = loaded.goals[0];
    if (loadedGoal === undefined) throw new Error("loaded goal missing");

    expect(loadedGoal.status).toBe("aborted");
    expect(loadedGoal.autoContinue).toBe(false);
    expect(loadedGoal.activePath).toBeUndefined();
    expect(loadedGoal.archivedPath).toBe(archivedPath);
    expect(loaded.focusBySession.s1).toBeUndefined();
  });

  test("rejects unsafe state directories", () => {
    const cwd = makeTempDir("opencode-goal-x-");

    expect(() => resolveGoalPaths(cwd, "../outside")).toThrow("cannot traverse");
    expect(() => resolveGoalPaths(cwd, path.join(cwd, "absolute"))).toThrow("must be relative");
    expect(() => resolveGoalPaths(cwd, "bad\0dir")).toThrow("NUL");
  });

  test("reads only object-shaped ledger events", () => {
    const cwd = makeTempDir("opencode-goal-x-");
    const paths = resolveGoalPaths(cwd, ".opencode/goals");

    appendLedger(paths, { type: "valid", sessionID: "s1" });
    fs.appendFileSync(paths.ledgerFile, "[\"array\"]\nnull\n\"text\"\n{\"type\":\"manual\"}\n");

    const events = readLedgerEvents(paths, 10);

    expect(events.map((event) => event.type)).toEqual(["valid", "manual"]);
  });
});

function createStoredGoal(objective: string): { paths: GoalPaths; goal: GoalRecord } {
  const cwd = makeTempDir("opencode-goal-x-");
  const paths = resolveGoalPaths(cwd, ".opencode/goals");
  const goal = writeGoalMarkdown(paths, createGoal({ objective, sessionID: "s1", autoContinue: true }));
  let store = upsertGoal(createEmptyStore(), goal);
  store = focusGoal(store, "s1", goal.id);
  saveStore(paths, store);
  return { paths, goal };
}

function activePathExists(goal: GoalRecord): boolean {
  if (goal.activePath === undefined) return false;
  return fs.existsSync(goal.activePath);
}

function archivedPathExists(goal: GoalRecord): boolean {
  if (goal.archivedPath === undefined) return false;
  return fs.existsSync(goal.archivedPath);
}

function firstLoadedGoal(setup: { paths: GoalPaths; goal: GoalRecord }): GoalRecord {
  const loaded = loadStore(setup.paths);
  expect(loaded.goals).toHaveLength(1);
  expect(loaded.focusBySession.s1).toBe(setup.goal.id);
  const loadedGoal = loaded.goals[0];
  if (loadedGoal === undefined) throw new Error("loaded goal missing");
  return loadedGoal;
}
