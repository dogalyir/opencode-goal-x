import { describe, expect, test } from "bun:test";
import { buildAuditorPromptInput, normalizeAuditPromptResponse, normalizeAuditSessionResponse, parseAuditDecision } from "../src/audit";
import { requireDefined } from "./assertions";

describe("completion audit helpers", () => {
  test("approves only a single final approval marker", () => {
    expect(parseAuditDecision("Looks good.\n<approved/>")).toEqual({ approved: true });
    expect(parseAuditDecision("<approved/>\nextra").approved).toBe(false);
    expect(parseAuditDecision("<approved/>\n<rejected/>").approved).toBe(false);
    expect(parseAuditDecision("no marker").approved).toBe(false);
  });

  test("validates auditor session API responses before use", () => {
    expect(normalizeAuditSessionResponse({ data: { id: "audit-session" } })).toEqual({ ok: true, value: { id: "audit-session" } });
    expect(normalizeAuditSessionResponse({ data: {} }).ok).toBe(false);
    expect(normalizeAuditSessionResponse({ error: { message: "no" } }).ok).toBe(false);
  });

  test("validates auditor prompt API responses before extracting text", () => {
    const valid = normalizeAuditPromptResponse({ data: { parts: [{ type: "text", text: "ok" }] } });

    expect(valid.ok).toBe(true);
    if (valid.ok === false) throw new Error(valid.message);
    expect(valid.value.parts).toHaveLength(1);
    expect(normalizeAuditPromptResponse({ data: { parts: [{ type: "text", text: 1 }] } }).ok).toBe(false);
    expect(normalizeAuditPromptResponse({ error: { message: "no" } }).ok).toBe(false);
  });

  test("auditor prompt input preserves variant and read-only tool policy", () => {
    const input = buildAuditorPromptInput({
      directory: "/tmp/project",
      goalID: "goal-1",
      prompt: "audit this",
      context: {
        auditorSessionID: "audit-1",
        agent: "plan",
        model: { providerID: "anthropic", modelID: "claude" },
        modelLabel: "anthropic/claude",
        variant: "xhigh",
        tools: { edit: false, write: false, bash: false },
      },
    });

    expect(input.body.agent).toBe("plan");
    expect(input.body.model).toEqual({ providerID: "anthropic", modelID: "claude" });
    const tools = requireDefined(input.body.tools, "auditor tools");
    expect(input.body.variant).toBe("xhigh");
    expect(tools.edit).toBe(false);
    expect(tools.bash).toBe(false);
  });
});
