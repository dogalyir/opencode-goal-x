import { z } from "zod";
import { OpenCodeTodoSnapshotSchema, type OpenCodeTodoSnapshot } from "./todo-sync";
import type { MaybeUndefined, OperationResult } from "./types";

const SessionEventPropertiesSchema = z.object({
  sessionID: z.string().min(1),
}).passthrough();

const ExecutionModelCandidateSchema = z.object({
  providerID: z.unknown().optional(),
  modelID: z.unknown().optional(),
  id: z.unknown().optional(),
}).passthrough();

const TokenUsageSchema = z.object({
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  reasoning: z.number().finite().nonnegative(),
}).passthrough();

const MessageInfoSchema = z.object({
  id: z.string().min(1),
  sessionID: z.string().min(1),
  role: z.string().min(1),
  agent: z.unknown().optional(),
  model: ExecutionModelCandidateSchema.optional(),
  time: z.object({
    created: z.number().finite().nonnegative(),
  }).passthrough(),
  tokens: TokenUsageSchema.optional(),
}).passthrough();

const SessionIdleEventSchema = z.object({
  type: z.literal("session.idle"),
  properties: SessionEventPropertiesSchema,
}).passthrough();

const SessionCompactedEventSchema = z.object({
  type: z.literal("session.compacted"),
  properties: SessionEventPropertiesSchema,
}).passthrough();

const MessageUpdatedEventSchema = z.object({
  type: z.literal("message.updated"),
  properties: z.object({
    info: MessageInfoSchema,
  }).passthrough(),
}).passthrough();

const TodoUpdatedEventSchema = z.object({
  type: z.literal("todo.updated"),
  properties: z.object({
    sessionID: z.string().min(1),
    todos: z.array(OpenCodeTodoSnapshotSchema),
  }).passthrough(),
}).passthrough();

const OpenCodeEventSchema = z.discriminatedUnion("type", [
  SessionIdleEventSchema,
  SessionCompactedEventSchema,
  MessageUpdatedEventSchema,
  TodoUpdatedEventSchema,
]);

export type OpenCodeMessageSnapshot = z.infer<typeof MessageInfoSchema>;

type ParsedOpenCodeEvent = z.infer<typeof OpenCodeEventSchema>;

export type NormalizedOpenCodeEvent =
  | { type: "session.idle"; sessionID: string }
  | { type: "session.compacted"; sessionID: string }
  | { type: "message.updated"; info: OpenCodeMessageSnapshot }
  | { type: "todo.updated"; sessionID: string; todos: OpenCodeTodoSnapshot[] };

export function normalizeOpenCodeEvent(rawEvent: unknown): OperationResult<NormalizedOpenCodeEvent> {
  const parsed = OpenCodeEventSchema.safeParse(rawEvent);
  if (parsed.success === false) return { ok: false, message: "OpenCode event payload has invalid shape." };
  return normalizeParsedOpenCodeEvent(parsed.data);
}

function normalizeParsedOpenCodeEvent(event: ParsedOpenCodeEvent): OperationResult<NormalizedOpenCodeEvent> {
  if (event.type === "session.idle") return { ok: true, value: { type: event.type, sessionID: event.properties.sessionID } };
  if (event.type === "session.compacted") return { ok: true, value: { type: event.type, sessionID: event.properties.sessionID } };
  if (event.type === "todo.updated") return { ok: true, value: { type: event.type, sessionID: event.properties.sessionID, todos: event.properties.todos } };
  return normalizeMessageUpdatedEvent(event.properties.info);
}

function normalizeMessageUpdatedEvent(info: OpenCodeMessageSnapshot): OperationResult<NormalizedOpenCodeEvent> {
  if (info.role === "assistant" && info.tokens === undefined) {
    return { ok: false, message: "OpenCode assistant message event is missing token usage." };
  }
  return { ok: true, value: { type: "message.updated", info } };
}

export function assistantMessageTokens(message: OpenCodeMessageSnapshot): MaybeUndefined<NonNullable<OpenCodeMessageSnapshot["tokens"]>> {
  if (message.role !== "assistant") return undefined;
  return message.tokens;
}
