import type { SessionPromptData as LegacySessionPromptData } from "@opencode-ai/sdk";
import type { SessionPromptData as CurrentSessionPromptData } from "@opencode-ai/sdk/v2";
import { promptContextFromExecutionContext } from "./execution-context";
import type { SessionExecutionContext, TextPromptPart } from "./types";

type LegacyPromptBody = NonNullable<LegacySessionPromptData["body"]>;
type CurrentVariant = NonNullable<CurrentSessionPromptData["body"]>["variant"];

type VariantAwarePromptBody = Omit<LegacyPromptBody, "parts"> & {
  variant?: CurrentVariant;
  parts: TextPromptPart[];
};

export interface VariantAwareTextPromptInput {
  path: { id: string };
  query: { directory: string };
  body: VariantAwarePromptBody;
}

export interface VariantAwareTextPromptOptions {
  sessionID: string;
  directory: string;
  text: string;
  executionContext?: SessionExecutionContext;
}

export function buildVariantAwareTextPrompt(input: VariantAwareTextPromptOptions): VariantAwareTextPromptInput {
  const promptContext = promptContextFromExecutionContext(input.executionContext);
  return {
    path: { id: input.sessionID },
    query: { directory: input.directory },
    body: {
      agent: promptContext.agent,
      model: promptContext.model,
      variant: promptContext.variant,
      messageID: promptContext.messageID,
      parts: [{ type: "text", text: input.text }],
    },
  };
}
