import { describe, expect, test } from "bun:test";
import { hasPendingSubtasks, validateTaskTree } from "../src/task-validation";
import type { GoalTask } from "../src/types";

const options = { maxTaskCount: 3, maxSubtaskDepth: 1, strictTaskContracts: true };

describe("task lifecycle validation", () => {
  test("rejects duplicate task ids", () => {
    const tasks: GoalTask[] = [
      { id: "same", title: "One", status: "pending" },
      { id: "same", title: "Two", status: "pending" },
    ];

    const result = validateTaskTree(tasks, options);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.message).toContain("duplicate");
  });

  test("rejects excessive task count and subtask depth", () => {
    const tooMany = validateTaskTree([
      { id: "one", title: "One", status: "pending" },
      { id: "two", title: "Two", status: "pending" },
      { id: "three", title: "Three", status: "pending" },
      { id: "four", title: "Four", status: "pending" },
    ], options);

    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) throw new Error("expected max count failure");
    expect(tooMany.message).toContain("more than 3");

    const tooDeep = validateTaskTree([
      {
        id: "parent",
        title: "Parent",
        status: "pending",
        subtasks: [
          {
            id: "child",
            title: "Child",
            status: "pending",
            subtasks: [{ id: "grandchild", title: "Grandchild", status: "pending" }],
          },
        ],
      },
    ], options);

    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) throw new Error("expected depth failure");
    expect(tooDeep.message).toContain("max subtask depth");
  });

  test("detects pending subtasks for parent completion gates", () => {
    const task: GoalTask = {
      id: "parent",
      title: "Parent",
      status: "pending",
      subtasks: [{ id: "child", title: "Child", status: "pending" }],
    };

    expect(hasPendingSubtasks(task)).toBe(true);
  });
});
