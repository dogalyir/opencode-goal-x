import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTIONS } from "../src/defaults";
import { normalizeOptions } from "../src/schemas";

describe("plugin option normalization", () => {
  test("keeps commandName usable after slash stripping", () => {
    expect(normalizeOptions({ commandName: "/goals" }).commandName).toBe("goals");
    expect(normalizeOptions({ commandName: "/" }).commandName).toBe(DEFAULT_OPTIONS.commandName);
  });

  test("normalizes command agent routing options", () => {
    expect(normalizeOptions({}).planningAgent).toBe(DEFAULT_OPTIONS.planningAgent);
    expect(normalizeOptions({}).executionAgent).toBe(DEFAULT_OPTIONS.executionAgent);
    expect(normalizeOptions({ planningAgent: "goal-planner", executionAgent: "goal-builder" }).planningAgent).toBe("goal-planner");
    expect(normalizeOptions({ planningAgent: "goal-planner", executionAgent: "goal-builder" }).executionAgent).toBe("goal-builder");
  });
});
