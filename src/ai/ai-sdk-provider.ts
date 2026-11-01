import { generateText, stepCountIs, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { AiCompletionRequest, AiCompletionResult, AiProvider, AiToolCallRecord } from "./provider.js";

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>;

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
    private readonly defaults: { maxOutputTokens: number; providerOptions?: ProviderOptions },
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

    const result = await generateText({
      model: this.languageModel,
      ...(system ? { system } : {}),
      messages,
      maxOutputTokens: Math.min(request.maxTokens ?? this.defaults.maxOutputTokens, this.defaults.maxOutputTokens),
      ...(tools ? { tools, stopWhen: stepCountIs(request.maxSteps ?? 5) } : {}),
      ...(this.defaults.providerOptions ? { providerOptions: this.defaults.providerOptions } : {}),
    });
    return {
      text: result.text,
      provider: this.name,
      model: this.model,
      ...(records.length ? { toolCalls: records } : {}),
    };
  }
}
