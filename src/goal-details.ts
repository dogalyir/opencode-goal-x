import type { GoalRecord } from "./types";

export function appendGoalContractLines(lines: string[], goal: GoalRecord, includeCompletionRule: boolean): void {
  if (goal.successCriteria !== undefined) lines.push(`Success criteria: ${goal.successCriteria}`);
  if (goal.constraints !== undefined) lines.push(`Constraints: ${goal.constraints}`);
  if (goal.verificationContract === undefined) return;
  if (includeCompletionRule) {
    lines.push("Verification contract:");
    lines.push(goal.verificationContract);
    lines.push("Rule: complete_goal must include verificationSummary that addresses every item in this contract.");
    return;
  }
  lines.push(`Verification contract: ${goal.verificationContract}`);
}
