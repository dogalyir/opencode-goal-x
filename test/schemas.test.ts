import { describe, expect, test } from "bun:test";
import { DEFAULT_OPTIONS } from "../src/defaults";
import { normalizeOptions } from "../src/schemas";

describe("plugin option normalization", () => {
  test("keeps commandName usable after slash stripping", () => {
    expect(normalizeOptions({ commandName: "/goals" }).commandName).toBe("goals");
    expect(normalizeOptions({ commandName: "/" }).commandName).toBe(DEFAULT_OPTIONS.commandName);
  });
});
