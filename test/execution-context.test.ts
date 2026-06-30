import { describe, expect, test } from "bun:test";
import { mergeExecutionContext, promptContextFromExecutionContext } from "../src/execution-context";

describe("session execution context", () => {
  test("captures agent model variant and forwards them to prompt bodies", () => {
    const context = mergeExecutionContext(undefined, {
      sessionID: "s1",
      agent: "plan",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      variant: "xhigh",
      messageID: "m1",
      source: "chat.message",
      timestamp: Date.UTC(2026, 0, 1),
    });

    expect(context.agent).toBe("plan");
    expect(context.providerID).toBe("anthropic");
    expect(context.modelID).toBe("claude-sonnet");
    expect(context.variant).toBe("xhigh");

    const promptContext = promptContextFromExecutionContext(context);
    expect(promptContext.agent).toBe("plan");
    expect(promptContext.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet" });
    expect(promptContext.variant).toBe("xhigh");
    expect(promptContext.messageID).toBe("m1");
  });

  test("partial command context does not erase a previously captured variant", () => {
    const previous = mergeExecutionContext(undefined, {
      sessionID: "s1",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5" },
      variant: "xhigh",
      messageID: "m1",
      source: "chat.message",
    });

    const next = mergeExecutionContext(previous, {
      sessionID: "s1",
      source: "command.execute.before",
    });

    expect(next.agent).toBe("build");
    expect(next.providerID).toBe("openai");
    expect(next.modelID).toBe("gpt-5");
    expect(next.variant).toBe("xhigh");
  });
});
