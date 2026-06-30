import { describe, expect, test } from "bun:test";
import { tuiCommandParameters } from "../src/tui-command";

describe("TUI command API", () => {
  test("uses current v2 flat executeCommand parameters", () => {
    const parameters = tuiCommandParameters("/repo", "/goal-confirm");

    expect(parameters).toEqual({ directory: "/repo", command: "/goal-confirm" });
    expect("body" in parameters).toBe(false);
    expect("query" in parameters).toBe(false);
  });
});
