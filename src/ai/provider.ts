import type { z } from "zod";

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A tool the model may call. Provider-neutral; adapted to the AI SDK in ai-sdk-provider.ts. */
export interface AiToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<unknown>;
}

export interface AiToolCallRecord {
  name: string;
  input: unknown;
  output: unknown;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  /** Maximum output tokens for this call (the app caps it with AI_MAX_OUTPUT_TOKENS). */
  maxTokens?: number;
  /** Agent task name, e.g. "draftListing". Lets the offline provider pick its answer. */
  task?: string;
  /** Tools the model may call during this completion (free chat). */
  tools?: AiToolSpec[];
  /** Maximum model steps when tools are present. Default 5. */
  maxSteps?: number;
  /**
   * Called right before every model call (each tool step and each retry counts). Throws to
   * refuse the call, e.g. when the daily AI budget is used up.
   */
  onModelCall?: () => void;
  /** Checked between tool steps; false stops the run after the current step. */
  canContinue?: () => boolean;
}

export interface AiCompletionResult {
  text: string;
  /** Provider name, for logging and the UI. */
  provider: string;
  model?: string;
  toolCalls?: AiToolCallRecord[];
}

/** The one seam the app talks to. Swap implementations without touching callers. */
export interface AiProvider {
  readonly name: string;
  readonly model?: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
