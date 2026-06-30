import { describe, expect, test } from "bun:test";
import { buildVariantAwareTextPrompt } from "../src/session-prompt";
import type { SessionExecutionContext } from "../src/types";

describe("variant-aware session prompts", () => {
  test("builds a current-SDK-compatible body with variant", () => {
    const executionContext: SessionExecutionContext = {
      sessionID: "s1",
      agent: "build",
      providerID: "anthropic",
      modelID: "claude",
      variant: "xhigh",
      lastUserMessageID: "m1",
      source: "chat.message",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const input = buildVariantAwareTextPrompt({ sessionID: "s1", directory: "/repo", text: "continue", executionContext });

    expect(input.body.agent).toBe("build");
    expect(input.body.model).toEqual({ providerID: "anthropic", modelID: "claude" });
    expect(input.body.variant).toBe("xhigh");
    expect(input.body.messageID).toBe("m1");
    expect(input.body.parts).toEqual([{ type: "text", text: "continue" }]);
  });
});
