import { z } from "zod";
import { auditPrompt } from "./prompts";
import { errorMessage } from "./errors";
import type {
  AuditRequest,
  AuditResult,
  ExecutionModel,
  GoalRuntimeOptions,
  MaybeUndefined,
  OperationResult,
  SessionExecutionContext,
  TextPromptPart,
  ToolPermissionMap,
} from "./types";

const READ_ONLY_AUDITOR_TOOLS: ToolPermissionMap = {
  edit: false,
  write: false,
  apply_patch: false,
  patch: false,
  bash: false,
  shell: false,
};

interface AuditPromptInput {
  path: { id: string };
  query: { directory: string };
  body: AuditPromptBody;
}

interface AuditPromptBody {
  agent?: string;
  model?: ExecutionModel;
  variant?: string;
  tools?: ToolPermissionMap;
  parts: TextPromptPart[];
}

interface AuditorPromptContext {
  auditorSessionID: string;
  agent?: string;
  model?: ExecutionModel;
  modelLabel?: string;
  variant?: string;
  tools?: ToolPermissionMap;
}

interface AuditorModelResolution {
  value?: ExecutionModel;
  label?: string;
}

type AuditRejectionDetails = Partial<Pick<AuditResult, "auditorSessionID" | "model" | "variant">>;

const AuditSessionResponseSchema = z.object({
  error: z.unknown().optional(),
  data: z.object({
    id: z.string().min(1),
  }).optional(),
}).passthrough();

const AuditPromptOutputPartSchema = z.object({
  type: z.string().min(1),
  text: z.string().optional(),
}).passthrough();

const AuditPromptResponseSchema = z.object({
  error: z.unknown().optional(),
  data: z.object({
    parts: z.array(AuditPromptOutputPartSchema),
  }).optional(),
}).passthrough();

type AuditSessionData = NonNullable<z.infer<typeof AuditSessionResponseSchema>["data"]>;
type AuditPromptData = NonNullable<z.infer<typeof AuditPromptResponseSchema>["data"]>;
type AuditPromptOutputPart = z.infer<typeof AuditPromptOutputPartSchema>;

export async function runCompletionAudit(request: AuditRequest): Promise<AuditResult> {
  reportAuditProgress(request, "Creating independent auditor session.");
  const auditSessionResult = await withTimeout(
    request.client.session.create({
      body: { parentID: request.parentSessionID, title: `Goal audit ${request.goal.id}` },
      query: { directory: request.directory },
    }),
    request.options.auditTimeoutMs,
  );
  if (auditSessionResult.ok === false) return rejected(`Could not create auditor session: ${auditSessionResult.message}`);

  const auditSession = normalizeAuditSessionResponse(auditSessionResult.value);
  if (auditSession.ok === false) return rejected(`Could not create auditor session: ${auditSession.message}`);
  const auditSessionData = auditSession.value;
  const context = buildAuditorPromptContext(auditSessionData.id, request.options, request.executionContext);
  reportAuditProgress(request, "Sending read-only-oriented audit prompt.", auditSessionData.id);
  const promptResult = await withTimeout(
    request.client.session.prompt(buildAuditorPromptInput({
      directory: request.directory,
      goalID: request.goal.id,
      prompt: auditPrompt(request.goal, request.completionSummary, request.verificationSummary),
      context,
    })),
    request.options.auditTimeoutMs,
  );

  if (promptResult.ok === false) return auditFailure(context, promptResult.message);

  const promptResponse = normalizeAuditPromptResponse(promptResult.value);
  if (promptResponse.ok === false) return auditFailure(context, promptResponse.message);

  const output = extractText(promptResponse.value.parts);
  const decision = parseAuditDecision(output);
  reportAuditProgress(request, decision.approved ? "Audit approved completion." : decision.error, auditSessionData.id);
  return {
    approved: decision.approved,
    output,
    auditorSessionID: context.auditorSessionID,
    model: context.modelLabel,
    variant: context.variant,
    error: decision.approved ? undefined : decision.error,
  };
}

export function buildAuditorPromptInput(input: {
  directory: string;
  goalID: string;
  prompt: string;
  context: AuditorPromptContext;
}): AuditPromptInput {
  return {
    path: { id: input.context.auditorSessionID },
    query: { directory: input.directory },
    body: {
      agent: input.context.agent,
      model: input.context.model,
      variant: input.context.variant,
      tools: input.context.tools,
      parts: [{ type: "text", text: input.prompt }],
    },
  };
}

export function normalizeAuditSessionResponse(response: unknown): OperationResult<AuditSessionData> {
  const parsed = AuditSessionResponseSchema.safeParse(response);
  if (parsed.success === false) return { ok: false, message: "response shape was invalid." };
  if (parsed.data.error !== undefined) return { ok: false, message: "OpenCode returned an error response." };
  if (parsed.data.data === undefined) return { ok: false, message: "response data was missing." };
  return { ok: true, value: parsed.data.data };
}

export function normalizeAuditPromptResponse(response: unknown): OperationResult<AuditPromptData> {
  const parsed = AuditPromptResponseSchema.safeParse(response);
  if (parsed.success === false) return { ok: false, message: "Auditor prompt response shape was invalid." };
  if (parsed.data.error !== undefined) return { ok: false, message: "Auditor prompt failed." };
  if (parsed.data.data === undefined) return { ok: false, message: "Auditor prompt response data was missing." };
  return { ok: true, value: parsed.data.data };
}

export function parseAuditDecision(output: string): { approved: true } | { approved: false; error: string } {
  const approvedMarkers = output.match(/<approved\s*\/>/gi) ?? [];
  const rejectedMarkers = output.match(/<rejected\s*\/>/gi) ?? [];
  if (approvedMarkers.length === 1 && rejectedMarkers.length === 0 && /<approved\s*\/>(?:\s*)$/i.test(output)) {
    return { approved: true };
  }
  if (rejectedMarkers.length > 0) return { approved: false, error: "Audit rejected completion." };
  if (approvedMarkers.length > 1) return { approved: false, error: "Audit returned contradictory approval markers." };
  return { approved: false, error: "Audit did not end with exactly one <approved/> marker." };
}

function buildAuditorPromptContext(
  auditorSessionID: string,
  options: GoalRuntimeOptions,
  executionContext: MaybeUndefined<SessionExecutionContext>,
): AuditorPromptContext {
  const model = resolveAuditorModel(options, executionContext);
  const variant = options.auditorVariant ?? executionContextText(executionContext, "variant");
  return {
    auditorSessionID,
    agent: options.auditorAgent ?? executionContextText(executionContext, "agent"),
    model: model.value,
    modelLabel: model.label,
    variant,
    tools: options.readonlyAuditor ? READ_ONLY_AUDITOR_TOOLS : undefined,
  };
}

function resolveAuditorModel(
  options: GoalRuntimeOptions,
  executionContext: MaybeUndefined<SessionExecutionContext>,
): AuditorModelResolution {
  const configured = parseAuditorModel(options.auditorModel);
  if (configured.ok) return modelResolution(configured.value);
  if (executionContext === undefined) return {};
  if (executionContext.providerID === undefined) return {};
  if (executionContext.modelID === undefined) return {};
  return modelResolution({ providerID: executionContext.providerID, modelID: executionContext.modelID });
}

function auditFailure(context: AuditorPromptContext, error: string): AuditResult {
  return rejected(error, {
    auditorSessionID: context.auditorSessionID,
    model: context.modelLabel,
    variant: context.variant,
  });
}

function modelResolution(value: ExecutionModel): Required<AuditorModelResolution> {
  return { value, label: `${value.providerID}/${value.modelID}` };
}

function executionContextText(
  executionContext: MaybeUndefined<SessionExecutionContext>,
  field: "agent" | "variant",
): MaybeUndefined<string> {
  if (executionContext === undefined) return undefined;
  return executionContext[field];
}

function reportAuditProgress(request: AuditRequest, message: string, auditorSessionID?: string): void {
  if (request.onProgress === undefined) return;
  request.onProgress(message, auditorSessionID);
}

function parseAuditorModel(auditorModel: MaybeUndefined<string>): OperationResult<ExecutionModel> {
  if (auditorModel === undefined) return { ok: false, message: "No auditor model configured." };
  const slash = auditorModel.indexOf("/");
  if (slash <= 0) return { ok: false, message: "Auditor model must use provider/model format." };
  const providerID = auditorModel.slice(0, slash);
  const modelID = auditorModel.slice(slash + 1);
  if (providerID.length === 0 || modelID.length === 0) return { ok: false, message: "Auditor model must use provider/model format." };
  return { ok: true, value: { providerID, modelID } };
}

function extractText(parts: AuditPromptOutputPart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (part.text === undefined) continue;
    chunks.push(part.text);
  }
  return chunks.join("\n\n").trim();
}

function rejected(message: string, details?: AuditRejectionDetails): AuditResult {
  const result: AuditResult = { approved: false, output: "", error: message };
  if (details === undefined) return result;
  return { ...result, ...details };
}

function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<OperationResult<Value>> {
  return new Promise<OperationResult<Value>>((resolve) => {
    const timer = setTimeout(() => {
      resolve({ ok: false, message: `Timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ ok: false, message: errorMessage(error) });
      },
    );
  });
}
