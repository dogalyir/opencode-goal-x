import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEmptyStore, createGoal, focusGoal, updateGoalStatus, upsertGoal } from "../src/goal";
import { loadStore, resolveGoalPaths, saveStore, writeGoalMarkdown } from "../src/storage";
import type { GoalPaths, GoalRecord } from "../src/types";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) fs.rmSync(tempDir, { recursive: true, force: true });
});

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
});

function makeTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-goal-x-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function createStoredGoal(objective: string): { paths: GoalPaths; goal: GoalRecord } {
  const cwd = makeTempDir();
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
