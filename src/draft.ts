import { randomUUID } from "node:crypto";
import { cleanGoalContractDetails, nowIso, type GoalContractInput } from "./goal";
import { renderTaskTree } from "./task-render";
import type { GoalBudget, GoalDraft, GoalDraftMap, GoalTaskList, MaybeUndefined } from "./types";

export type CreateGoalDraftInput = Pick<GoalDraft, "sessionID" | "topic" | "objective"> & GoalContractInput & {
  taskList?: GoalTaskList;
  budgetOverrides?: Partial<GoalBudget>;
  autoContinue?: boolean;
  status?: GoalDraft["status"];
  now?: number;
};

export function createGoalDraft(input: CreateGoalDraftInput): GoalDraft {
  const createdAt = nowIso(input.now);
  return {
    id: randomUUID(),
    sessionID: input.sessionID,
    status: input.status ?? "proposed",
    topic: input.topic.trim(),
    objective: input.objective.trim(),
    ...cleanGoalContractDetails(input),
    taskList: input.taskList,
    budgetOverrides: input.budgetOverrides,
    autoContinue: input.autoContinue ?? true,
    createdAt,
    updatedAt: createdAt,
  };
}

export function formatGoalDraftHeaderLines(draft: Pick<GoalDraft, "id" | "status" | "topic">): string[] {
  return [`Draft ID: ${draft.id}`, `Status: ${draft.status}`, `Topic: ${draft.topic}`];
}

export function formatGoalDraftConfirmation(draft: GoalDraft): string {
  const lines = [
    "Goal draft ready for confirmation.",
    "",
    ...formatGoalDraftHeaderLines(draft),
    "",
    "=== Goal Draft ===",
    `Objective: ${draft.objective}`,
  ];

  if (draft.successCriteria !== undefined) lines.push(`Success criteria: ${draft.successCriteria}`);
  if (draft.constraints !== undefined) lines.push(`Constraints: ${draft.constraints}`);
  if (draft.verificationContract !== undefined) lines.push(`Verification contract: ${draft.verificationContract}`);
  if (draft.taskList !== undefined) {
    lines.push("");
    lines.push(`Tasks (${draft.taskList.blockCompletion ? "blocking" : "non-blocking"}):`);
    lines.push(...renderTaskTree(draft.taskList.tasks, { mode: "prompt", includeEvidenceLines: true }));
  }

  lines.push("");
  lines.push("No goal has been created yet.");
  lines.push("To start exactly this draft, run `/goal-confirm` or `/goal-confirm " + draft.id + "`.");
  lines.push("To discard it, run `/goal-reject`.");
  return lines.join("\n");
}

export function findSessionDraft(drafts: MaybeUndefined<GoalDraftMap>, sessionID: string, draftID?: string): MaybeUndefined<GoalDraft> {
  if (drafts === undefined) return undefined;
  if (draftID !== undefined && draftID.trim().length > 0) return drafts[draftID.trim()];
  let latest: MaybeUndefined<GoalDraft>;
  for (const draft of Object.values(drafts)) {
    if (draft.sessionID !== sessionID) continue;
    if (latest === undefined) {
      latest = draft;
      continue;
    }
    if (draft.updatedAt > latest.updatedAt) latest = draft;
  }
  return latest;
}

export function upsertDraft(drafts: MaybeUndefined<GoalDraftMap>, draft: GoalDraft): GoalDraftMap {
  return {
    ...drafts,
    [draft.id]: { ...draft, updatedAt: nowIso() },
  };
}

export function removeDraft(drafts: MaybeUndefined<GoalDraftMap>, draftID: string): GoalDraftMap {
  const next: GoalDraftMap = { ...drafts };
  delete next[draftID];
  return next;
}
