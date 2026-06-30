import { describe, expect, test } from "bun:test";
import { createGoal, shouldSuppressGenericCompactionAutocontinue, updateGoalStatus } from "../src/goal";

describe("compaction autocontinue policy", () => {
  test("suppresses generic OpenCode autocontinue only for active autoContinue goals", () => {
    const active = createGoal({ objective: "Keep going", sessionID: "s1", autoContinue: true });
    const paused = updateGoalStatus(active, "paused", { autoContinue: false });
    const inactiveAuto = updateGoalStatus(active, "active", { autoContinue: false });

    expect(shouldSuppressGenericCompactionAutocontinue(active)).toBe(true);
    expect(shouldSuppressGenericCompactionAutocontinue(paused)).toBe(false);
    expect(shouldSuppressGenericCompactionAutocontinue(inactiveAuto)).toBe(false);
    expect(shouldSuppressGenericCompactionAutocontinue(undefined)).toBe(false);
  });
});
