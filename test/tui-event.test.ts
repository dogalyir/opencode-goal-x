import { describe, expect, test } from "bun:test";
import { sessionIDFromMessageUpdatedEvent } from "../src/tui";

const created = Date.now();

describe("TUI SDK event boundary validation", () => {
  test("extracts session id from validated message.updated events", () => {
    const sessionID = sessionIDFromMessageUpdatedEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "user-1",
          sessionID: "s1",
          role: "user",
          time: { created },
        },
      },
    });

    expect(sessionID).toBe("s1");
  });

  test("rejects malformed TUI message events before reading nested fields", () => {
    expect(sessionIDFromMessageUpdatedEvent({ type: "message.updated", properties: {} })).toBeUndefined();
    expect(sessionIDFromMessageUpdatedEvent({ type: "message.updated", properties: { info: { sessionID: "s1" } } })).toBeUndefined();
    expect(sessionIDFromMessageUpdatedEvent({ type: "todo.updated", properties: { sessionID: "s1", todos: [] } })).toBeUndefined();
  });
});
