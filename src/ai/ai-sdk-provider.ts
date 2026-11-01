import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AiCompletionRequest, AiCompletionResult, AiProvider, AiToolCallRecord } from "./provider.js";

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

export const AI_TIMEOUT_MS = 45_000;

/** The model did not finish within the deadline; the call was aborted. */
export class AiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The AI model did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "AiTimeoutError";
  }
}

/**
 * Real model through the Vercel AI SDK (ai@6). One class for every vendor;
 * the vendor-specific LanguageModel is created in ai/index.ts.
 * No temperature is sent: newer models reject sampling parameters.
 */
export class AiSdkProvider implements AiProvider {
  constructor(
    readonly name: string,
    readonly model: string,
    private readonly languageModel: LanguageModel,
    private readonly defaults: { maxOutputTokens: number; providerOptions?: ProviderOptions; timeoutMs?: number },
  ) {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const system = request.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages: ModelMessage[] = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const records: AiToolCallRecord[] = [];
    let tools: ToolSet | undefined;
    if (request.tools?.length) {
      tools = {};
      for (const spec of request.tools) {
        tools[spec.name] = tool({
          description: spec.description,
          inputSchema: spec.inputSchema,
          execute: async (input: unknown) => {
            const output = await spec.execute(input);
            records.push({ name: spec.name, input, output });
            return output;
          },
        });
      }
    }

    // One deadline for the whole call (a chat with tool steps is one call).
    const timeoutMs = this.defaults.timeoutMs ?? AI_TIMEOUT_MS;
    const abortSignal = AbortSignal.timeout(timeoutMs);
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({
        model: this.languageModel,
        ...(system ? { system } : {}),
        messages,
        maxOutputTokens: Math.min(request.maxTokens ?? this.defaults.maxOutputTokens, this.defaults.maxOutputTokens),
        ...(tools ? { tools, stopWhen: [stepCountIs(request.maxSteps ?? 5), ...(request.canContinue ? [() => !request.canContinue!()] : [])] } : {}),
        // Every step is a model call: count it before it happens (daily AI budget).
        ...(request.onModelCall ? { prepareStep: () => (request.onModelCall!(), undefined) } : {}),
        ...(this.defaults.providerOptions ? { providerOptions: this.defaults.providerOptions } : {}),
        abortSignal,
      });
    } catch (err) {
      if (abortSignal.aborted) throw new AiTimeoutError(timeoutMs);
      throw err;
    }
    return {
      text: result.text,
      provider: this.name,
      model: this.model,
      finishReason: result.finishReason,
      ...(records.length ? { toolCalls: records } : {}),
    };
  }
}
