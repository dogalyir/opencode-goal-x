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

  test("parses plural /goals aliases like /goal", () => {
    const draft = requireParseSuccess(parseGoalCommand("goals", "goal", "draft with plural alias"));
    const confirm = requireParseSuccess(parseGoalCommand("goals-confirm", "goal", "draft-1"));

    expect(draft.action).toBe("draft");
    expect(draft.objective).toBe("draft with plural alias");
    expect(confirm.action).toBe("confirm");
    expect(confirm.goalId).toBe("draft-1");
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

  test("keeps unknown flags in free-form goal text", () => {
    const parsed = parseGoalCommand("goal", "goal", "ship it --wat nope");

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("draft");
    expect(command.objective).toBe("ship it --wat nope");
  });

  test("parses free-form goals with apostrophes and multiline URLs", () => {
    const parsed = parseGoalCommand(
      "goal",
      "goal",
      "Your job is to maybe improve the readme.md to make more reference to the product, look at https://raw.githubusercontent.com/mohak34/opencode-notifier/refs/heads/main/README.md\n\nwhich is another plugin, they explain how to install it, we don't have that",
    );

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("draft");
    expect(command.objective).toContain("we don't have that");
    expect(command.objective).toContain("opencode-notifier");
  });

  test("keeps natural apostrophes in lifecycle command text", () => {
    const parsed = parseGoalCommand("goal-pause", "goal", "don't continue yet");

    const command = requireParseSuccess(parsed);
    expect(command.action).toBe("pause");
    expect(command.reason).toBe("don't continue yet");
  });

  test("splits quoted arguments", () => {
    const split = splitCommandLine("one \"two words\" 'three words'");

    expect(split.ok).toBe(true);
    if (split.ok === false) throw new Error(split.message);
    expect(split.value).toEqual(["one", "two words", "three words"]);
  });

  test("does not reject unclosed natural quotes", () => {
    const split = splitCommandLine("don\'t fail \"unfinished thought");

    expect(split.ok).toBe(true);
    if (split.ok === false) throw new Error(split.message);
    expect(split.value).toEqual(["don't", "fail", "unfinished thought"]);
  });
});

function requireParseSuccess(parsed: ReturnType<typeof parseGoalCommand>) {
  expect(parsed.ok).toBe(true);
  if (parsed.ok === false) throw new Error(parsed.message);
  return parsed.value;
}
