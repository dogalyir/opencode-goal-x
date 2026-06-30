import { auditPrompt } from "./prompts";
import { errorMessage } from "./errors";
import type { AuditRequest, AuditResult, GoalRuntimeOptions, OperationResult } from "./types";

export async function runCompletionAudit(request: AuditRequest): Promise<AuditResult> {
  const auditSessionResult = await withTimeout(
    request.client.session.create({
      body: { parentID: request.parentSessionID, title: `Goal audit ${request.goal.id}` },
      query: { directory: request.directory },
    }),
    request.options.auditTimeoutMs,
  );
  if (!auditSessionResult.ok) return rejected(`Could not create auditor session: ${auditSessionResult.message}`);

  const auditSessionResponse = auditSessionResult.value;
  if (auditSessionResponse.error !== undefined) return rejected("Could not create auditor session.");

  const auditSession = auditSessionResponse.data;
  const model = parseAuditorModel(request.options);
  const auditResultContext = {
    auditorSessionID: auditSession.id,
    model: model.ok ? request.options.auditorModel : undefined,
  };
  const promptResult = await withTimeout(
    request.client.session.prompt({
      path: { id: auditSession.id },
      query: { directory: request.directory },
      body: {
        agent: request.options.auditorAgent,
        model: model.ok ? model.value : undefined,
        parts: [{ type: "text", text: auditPrompt(request.goal, request.completionSummary, request.verificationSummary) }],
      },
    }),
    request.options.auditTimeoutMs,
  );

  if (!promptResult.ok) return auditFailure(auditResultContext, promptResult.message);

  const promptResponse = promptResult.value;
  if (promptResponse.error !== undefined) return auditFailure(auditResultContext, "Auditor prompt failed.");

  const output = extractText(promptResponse.data.parts);
  const approved = /<approved\s*\/>\s*$/m.test(output) && !/<rejected\s*\/>\s*$/m.test(output);
  return {
    approved,
    output,
    ...auditResultContext,
    error: approved ? undefined : "Audit rejected or did not return <approved/>.",
  };
}

function auditFailure(context: Pick<AuditResult, "auditorSessionID" | "model">, error: string): AuditResult {
  return { approved: false, output: "", ...context, error };
}

function parseAuditorModel(options: GoalRuntimeOptions): OperationResult<{ providerID: string; modelID: string }> {
  if (options.auditorModel === undefined) return { ok: false, message: "No auditor model configured." };
  const slash = options.auditorModel.indexOf("/");
  if (slash <= 0) return { ok: false, message: "Auditor model must use provider/model format." };
  const providerID = options.auditorModel.slice(0, slash);
  const modelID = options.auditorModel.slice(slash + 1);
  if (providerID.length === 0 || modelID.length === 0) return { ok: false, message: "Auditor model must use provider/model format." };
  return { ok: true, value: { providerID, modelID } };
}

function extractText(parts: { type: string; text?: string }[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") continue;
    if (part.text === undefined) continue;
    chunks.push(part.text);
  }
  return chunks.join("\n\n").trim();
}

function rejected(message: string): AuditResult {
  return { approved: false, output: "", error: message };
}

async function withTimeout<Value>(promise: Promise<Value>, timeoutMs: number): Promise<OperationResult<Value>> {
  return await new Promise<OperationResult<Value>>((resolve) => {
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
