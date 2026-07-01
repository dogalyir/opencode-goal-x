import { describe, expect, test } from "bun:test";
import { normalizeToolTaskList } from "../src/task-normalization";

describe("tool task normalization", () => {
  test("defaults omitted task statuses at every depth", () => {
    const normalized = normalizeToolTaskList([
      {
        id: "parent",
        title: "Parent",
        subtasks: [{ id: "child", title: "Child" }],
      },
    ]);

    expect(normalized.ok).toBe(true);
    if (normalized.ok === false) throw new Error(normalized.message);
    const parent = normalized.value[0];
    if (parent === undefined) throw new Error("parent task missing");
    expect(parent.status).toBe("pending");
    if (parent.subtasks === undefined) throw new Error("subtasks missing");
    const child = parent.subtasks[0];
    if (child === undefined) throw new Error("child task missing");
    expect(child.status).toBe("pending");
  });
});
