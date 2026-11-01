import type { AiCompletionRequest, AiCompletionResult, AiProvider, AiToolCallRecord } from "./provider.js";

/** A scripted reply. Objects may ask for tool calls, which the fake runs like the AI SDK would. */
export type FakeReplyValue = string | { text: string; toolCalls?: Array<{ name: string; input: unknown }> };
export type FakeReply = FakeReplyValue | ((request: AiCompletionRequest) => FakeReplyValue);

/**
 * Deterministic provider for tests and offline demos.
 * Returns scripted replies in order (the last one repeats) and records every request.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-offline";
  readonly calls: AiCompletionRequest[] = [];
  private index = 0;

  constructor(private readonly replies: FakeReply[] = ["(fake reply)"]) {
    if (replies.length === 0) throw new Error("FakeAiProvider needs at least one reply");
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)]!;
    this.index += 1;
    const value = typeof reply === "function" ? reply(request) : reply;
    if (typeof value === "string") return { text: value, provider: this.name };

    const toolCalls: AiToolCallRecord[] = [];
    for (const call of value.toolCalls ?? []) {
      const spec = request.tools?.find((t) => t.name === call.name);
      if (!spec) throw new Error(`fake provider asked for unknown tool ${call.name}`);
      const input = spec.inputSchema.parse(call.input);
      toolCalls.push({ name: call.name, input, output: await spec.execute(input) });
    }
    return { text: value.text, provider: this.name, ...(toolCalls.length ? { toolCalls } : {}) };
  }
}
