import { describe, expect, test } from "bun:test";
import { createGoalDraft, findSessionDraft, formatGoalDraftConfirmation, removeDraft, upsertDraft } from "../src/draft";
import { requireDefined } from "./assertions";

describe("goal drafting", () => {
  test("stores a draft confirmation without creating a goal", () => {
    const draft = createGoalDraft({ sessionID: "s1", topic: "fix tests", objective: "Fix tests with verification" });
    const drafts = upsertDraft(undefined, draft);

    expect(requireDefined(findSessionDraft(drafts, "s1"), "session draft").id).toBe(draft.id);
    expect(formatGoalDraftConfirmation(draft)).toContain("No goal has been created yet");
    expect(formatGoalDraftConfirmation(draft)).toContain("/goal-confirm");
  });

  test("removes rejected drafts", () => {
    const draft = createGoalDraft({ sessionID: "s1", topic: "fix tests", objective: "Fix tests" });
    const drafts = removeDraft(upsertDraft(undefined, draft), draft.id);

    expect(findSessionDraft(drafts, "s1")).toBeUndefined();
  });
});
