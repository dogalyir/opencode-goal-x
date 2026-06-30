import { describe, expect, test } from "bun:test";
import { createGoal, focusGoal, updateGoalStatus, upsertGoal } from "../src/goal";
import { createEmptyStore } from "../src/goal";
import { loadStore, resolveGoalPaths, saveStore, writeGoalMarkdown } from "../src/storage";
import { loadGoalDashboardState, renderFocusedGoalBadge, renderGoalDashboardText } from "../src/tui-state";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("TUI shared state", () => {
  test("renders focused goal badge and dashboard from authoritative files", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goal-x-tui-"));
    try {
      const paths = resolveGoalPaths(directory, ".opencode/goals");
      const goal = writeGoalMarkdown(paths, updateGoalStatus(createGoal({ objective: "Render dashboard", sessionID: "s1", autoContinue: true }), "paused", {
        pauseReason: "blocked",
        auditProgress: { status: "running", message: "auditing", updatedAt: "2026-01-01T00:00:00.000Z" },
      }));
      let store = upsertGoal(createEmptyStore(), goal);
      store = focusGoal(store, "s1", goal.id);
      saveStore(paths, store);
      expect(loadStore(paths).goals).toHaveLength(1);

      const state = loadGoalDashboardState({ directory, sessionID: "s1" });
      const badge = renderFocusedGoalBadge(state);
      const dashboard = renderGoalDashboardText(state);

      expect(badge).toContain("paused");
      expect(badge).toContain("audit:running");
      expect(dashboard).toContain("Render dashboard");
      expect(dashboard).toContain("Drafts pending confirmation");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
