import { describe, expect, test } from "bun:test";
import { createGoal, updateGoalStatus } from "../src/goal";
import { auditPrompt, compactionContext, continuationPrompt, goalSystemPrompt } from "../src/prompts";

describe("goal prompts", () => {
  test("system prompt enforces durable lifecycle tools", () => {
    const goal = createGoal({ objective: "Ship the feature", sessionID: "s1", autoContinue: true, verificationContract: "run tests" });
    const prompt = goalSystemPrompt(goal);

    expect(prompt).toContain("complete_goal");
    expect(prompt).toContain("pause_goal");
    expect(prompt).toContain("fail-closed audit");
    expect(prompt).toContain("run tests");
  });

  test("continuation prompt carries the stable goal marker", () => {
    const goal = createGoal({ objective: "Keep going", sessionID: "s1", autoContinue: true });
    const prompt = continuationPrompt(goal);

    expect(prompt).toContain(`<opencode_goal_x_continuation goal_id="${goal.id}">`);
    expect(prompt).toContain("Continue pursuing the active goal");
  });

  test("compaction prompt includes focused goal, other goals, ledger, and latest audit", () => {
    const focused = updateGoalStatus(createGoal({ objective: "Focused", sessionID: "s1", autoContinue: true }), "paused", {
      pauseReason: "waiting on user",
      audit: { decision: "rejected", summary: "missing evidence", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    const other = createGoal({ objective: "Other", sessionID: "s2", autoContinue: true });
    const prompt = compactionContext({
      focusedGoal: focused,
      openGoals: [focused, other],
      recentLedgerEvents: [{ type: "goal_audit_rejected", goalId: focused.id }],
    });

    expect(prompt).toContain("Focused goal");
    expect(prompt).toContain("Other open goals");
    expect(prompt).toContain("waiting on user");
    expect(prompt).toContain("goal_audit_rejected");
  });

  test("audit prompt requires exact final markers and read-only inspection", () => {
    const goal = createGoal({ objective: "Build durable goal mode", sessionID: "s1", autoContinue: true });
    const prompt = auditPrompt(goal, "done", "verified");

    expect(prompt).toContain("<approved/>");
    expect(prompt).toContain("<rejected/>");
    expect(prompt).toContain("claims are not proof");
    expect(prompt).toContain("read-only");
  });
});
