import { describe, expect, test } from "bun:test";
import ServerPlugin, { GoalXServerModule, GoalXServerPlugin } from "../src/server";
import IndexPlugin from "../src/index";
import TuiPlugin from "../src/tui";

describe("package module shapes", () => {
  test("server exports default plugin and server module", () => {
    expect(ServerPlugin).toBe(GoalXServerPlugin);
    expect(IndexPlugin).toBe(GoalXServerPlugin);
    expect(GoalXServerModule.id).toBe("opencode-goal-x");
    expect(GoalXServerModule.server).toBe(GoalXServerPlugin);
  });

  test("tui export is target-exclusive", () => {
    expect(TuiPlugin.id).toBe("opencode-goal-x");
    expect(typeof TuiPlugin.tui).toBe("function");
    expect("server" in TuiPlugin).toBe(false);
  });
});
