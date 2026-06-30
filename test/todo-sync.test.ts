import { describe, expect, test } from "bun:test";
import { createGoal } from "../src/goal";
import { syncGoalTasksFromTodos, taskToTodoContent } from "../src/todo-sync";
import type { GoalRecord, GoalTaskList } from "../src/types";
import { requireDefined } from "./assertions";

describe("OpenCode todo sync", () => {
  test("maps completed native todos to goal task evidence without losing contracts", () => {
    const setup = createTodoGoal();
    const firstTask = requireDefined(setup.taskList.tasks[0], "test task");

    const result = syncGoalTasksFromTodos(setup.goal, [{ id: "todo-1", content: taskToTodoContent(firstTask), status: "completed" }]);

    expect(result.updates).toHaveLength(1);
    const resultTaskList = requireDefined(result.goal.taskList, "result task list");
    const task = requireDefined(resultTaskList.tasks[0], "result task");
    expect(task.status).toBe("complete");
    expect(task.verificationContract).toBe("bun test must pass");
    expect(task.evidence).toContain("OpenCode todo todo-1");
  });

  test("rejects malformed todo SDK payloads without mutating goal tasks", () => {
    const setup = createTodoGoal();

    const result = syncGoalTasksFromTodos(setup.goal, [{ id: "", content: "Run tests", status: "completed" }]);

    expect(result.validationError).toBe("OpenCode todo payload has invalid shape.");
    expect(result.updates).toHaveLength(0);
    const taskList = requireDefined(result.goal.taskList, "result task list");
    const task = requireDefined(taskList.tasks[0], "result task");
    expect(task.status).toBe("pending");
  });
});

interface TodoGoalSetup {
  goal: GoalRecord;
  taskList: GoalTaskList;
}

function createTodoGoal(): TodoGoalSetup {
  const taskList: GoalTaskList = {
    blockCompletion: true,
    proposedAt: "2026-01-01T00:00:00.000Z",
    tasks: [
      {
        id: "tests",
        title: "Run tests",
        status: "pending",
        verificationContract: "bun test must pass",
      },
    ],
  };
  const goal = { ...createGoal({ objective: "Ship", sessionID: "s1", autoContinue: true }), taskList };
  return { goal, taskList };
}
