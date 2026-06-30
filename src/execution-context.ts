import { cleanOptionalText } from "./goal";
import type { ExecutionModel, MaybeUndefined, SessionExecutionContext } from "./types";

type ExecutionContextSource = SessionExecutionContext["source"];

export interface ExecutionModelCandidate {
  providerID?: unknown;
  modelID?: unknown;
  id?: unknown;
}

export interface ExecutionContextCandidate {
  sessionID: string;
  agent?: unknown;
  model?: ExecutionModelCandidate;
  providerID?: unknown;
  modelID?: unknown;
  variant?: unknown;
  messageID?: unknown;
  timestamp?: number;
  source: ExecutionContextSource;
}

export interface PromptExecutionContext {
  agent?: string;
  model?: ExecutionModel;
  variant?: string;
  messageID?: string;
}

export function mergeExecutionContext(
  existing: MaybeUndefined<SessionExecutionContext>,
  candidate: ExecutionContextCandidate,
  now = Date.now(),
): SessionExecutionContext {
  const model = normalizeModel(candidate.model, candidate.providerID, candidate.modelID);
  const agent = cleanUnknownText(candidate.agent) ?? existingText(existing, "agent");
  const variant = cleanUnknownText(candidate.variant) ?? existingText(existing, "variant");
  const lastUserMessageID = cleanUnknownText(candidate.messageID) ?? existingText(existing, "lastUserMessageID");
  const timestamp = candidate.timestamp ?? now;

  return {
    sessionID: candidate.sessionID,
    agent,
    providerID: modelText(model, existing, "providerID"),
    modelID: modelText(model, existing, "modelID"),
    variant,
    lastUserMessageID,
    source: candidate.source,
    updatedAt: new Date(timestamp).toISOString(),
  };
}

export function promptContextFromExecutionContext(context: MaybeUndefined<SessionExecutionContext>): PromptExecutionContext {
  if (context === undefined) return {};
  const model = context.providerID === undefined || context.modelID === undefined
    ? undefined
    : { providerID: context.providerID, modelID: context.modelID };
  return {
    agent: context.agent,
    model,
    variant: context.variant,
    messageID: context.lastUserMessageID,
  };
}

function normalizeModel(
  model: MaybeUndefined<ExecutionModelCandidate>,
  providerID: unknown,
  modelID: unknown,
): MaybeUndefined<ExecutionModel> {
  const providerFromModel = cleanUnknownModelField(model, "providerID");
  const modelIDFromModel = cleanUnknownModelField(model, "modelID") ?? cleanUnknownModelField(model, "id");
  const normalizedProviderID = providerFromModel ?? cleanUnknownText(providerID);
  const normalizedModelID = modelIDFromModel ?? cleanUnknownText(modelID);
  if (normalizedProviderID === undefined || normalizedModelID === undefined) return undefined;
  return { providerID: normalizedProviderID, modelID: normalizedModelID };
}

function modelText(
  model: MaybeUndefined<ExecutionModel>,
  existing: MaybeUndefined<SessionExecutionContext>,
  field: "providerID" | "modelID",
): MaybeUndefined<string> {
  if (model !== undefined) return model[field];
  return existingText(existing, field);
}

function existingText(
  existing: MaybeUndefined<SessionExecutionContext>,
  field: "agent" | "providerID" | "modelID" | "variant" | "lastUserMessageID",
): MaybeUndefined<string> {
  if (existing === undefined) return undefined;
  return existing[field];
}

function cleanUnknownModelField(model: MaybeUndefined<ExecutionModelCandidate>, field: keyof ExecutionModelCandidate): MaybeUndefined<string> {
  if (model === undefined) return undefined;
  return cleanUnknownText(model[field]);
}

function cleanUnknownText(value: unknown): MaybeUndefined<string> {
  if (typeof value !== "string") return undefined;
  return cleanOptionalText(value);
}
