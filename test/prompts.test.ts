import { describe, expect, test } from "bun:test";
import { createGoal } from "../src/goal";
import { auditPrompt, continuationPrompt, goalSystemPrompt } from "../src/prompts";

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

  test("audit prompt requires exact final markers", () => {
    const goal = createGoal({ objective: "Build durable goal mode", sessionID: "s1", autoContinue: true });
    const prompt = auditPrompt(goal, "done", "verified");

    expect(prompt).toContain("<approved/>");
    expect(prompt).toContain("<rejected/>");
    expect(prompt).toContain("claims are not proof");
  });
});
