import { describe, expect, test } from "bun:test";
import { normalizeOpenCodeEvent } from "../src/opencode-events";

const created = Date.now();

describe("OpenCode event boundary validation", () => {
  test("normalizes known event shapes", () => {
    expect(normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: "s1" } })).toEqual({ ok: true, value: { type: "session.idle", sessionID: "s1" } });
    expect(normalizeOpenCodeEvent({ type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "todo-1", content: "Run tests", status: "completed" }] } }).ok).toBe(true);
  });

  test("rejects malformed SDK event payloads before runtime use", () => {
    expect(normalizeOpenCodeEvent({ type: "session.idle", properties: { sessionID: "" } }).ok).toBe(false);
    expect(normalizeOpenCodeEvent({ type: "todo.updated", properties: { sessionID: "s1", todos: [{ id: "", content: "Run tests", status: "completed" }] } }).ok).toBe(false);
    expect(normalizeOpenCodeEvent({ type: "message.updated", properties: { info: assistantMessage({ input: "bad", output: 1, reasoning: 0 }) } }).ok).toBe(false);
    expect(normalizeOpenCodeEvent({ type: "message.updated", properties: { info: userMessageWithoutTokens() } }).ok).toBe(true);
  });
});

function assistantMessage(tokens: unknown): unknown {
  return {
    id: "assistant-1",
    sessionID: "s1",
    role: "assistant",
    time: { created },
    tokens,
  };
}

function userMessageWithoutTokens(): unknown {
  return {
    id: "user-1",
    sessionID: "s1",
    role: "user",
    time: { created },
  };
}
