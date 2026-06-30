import { describe, expect, test } from "bun:test";
import { parseGoalCommand, splitCommandLine } from "../src/commands";

describe("goal command parser", () => {
  test("parses /goal as a draft command with budget and contract flags", () => {
    const parsed = parseGoalCommand(
      "goal",
      "goal",
      "fix tests --max-turns 20 --budget 1.5m --success \"suite passes\" --constraints \"do not change public API\" --contract \"run bun test\"",
    );

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("draft");
    expect(command.objective).toBe("fix tests");
    expect(command.budgetOverrides.maxTurns).toBe(20);
    expect(command.budgetOverrides.maxTokens).toBe(1_500_000);
    expect(command.successCriteria).toBe("suite passes");
    expect(command.constraints).toBe("do not change public API");
    expect(command.verificationContract).toBe("run bun test");
  });

  test("parses /goal-set as immediate start", () => {
    const parsed = parseGoalCommand("goal-set", "goal", "ship it --max-turns 2");

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("start");
    expect(command.objective).toBe("ship it");
    expect(command.budgetOverrides.maxTurns).toBe(2);
  });

  test("maps draft confirmation commands", () => {
    const parsed = parseGoalCommand("goal-confirm", "goal", "draft-1");

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("confirm");
    expect(command.goalId).toBe("draft-1");
  });

  test("maps command aliases to lifecycle actions", () => {
    const parsed = parseGoalCommand("goal-resume", "goal", "");

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("resume");
  });

  test("rejects unknown flags", () => {
    const parsed = parseGoalCommand("goal", "goal", "ship it --wat nope");

    expect(expectParseFailure(parsed)).toContain("Unknown goal flag");
  });

  test("splits quoted arguments", () => {
    const split = splitCommandLine("one \"two words\" 'three words'");

    expect(split.ok).toBe(true);
    if (split.ok === false) throw new Error(split.message);
    expect(split.value).toEqual(["one", "two words", "three words"]);
  });
});

function requireParseSuccess(parsed: ReturnType<typeof parseGoalCommand>) {
  expect(parsed.ok).toBe(true);
  if (parsed.ok === false) throw new Error(parsed.message);
  return parsed.value;
}

function expectParseFailure(parsed: ReturnType<typeof parseGoalCommand>): string {
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("expected parse failure");
  return parsed.message;
}
