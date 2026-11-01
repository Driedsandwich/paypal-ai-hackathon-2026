import type { AiCompletionRequest, AiCompletionResult, AiProvider, AiToolCallRecord } from "./provider.js";

/** A scripted reply. Objects may ask for tool calls, which the fake runs like the AI SDK would. */
export type FakeReplyValue =
  | string
  | {
      text: string;
      toolCalls?: Array<{ name: string; input: unknown }>;
      /** Builds the final text from the tool results (like a model's second step). */
      after?: (calls: AiToolCallRecord[]) => string;
    };
export type FakeReply = FakeReplyValue | ((request: AiCompletionRequest) => FakeReplyValue);

export interface FakeAiProviderOptions {
  /**
   * Test-only: keep the most recent requests in `calls` (true = up to 50, or a number).
   * Off by default, so the offline demo provider never retains visitors' prompts.
   */
  record?: boolean | number;
}

/**
 * Deterministic provider for tests and offline demos.
 * Returns scripted replies in order (the last one repeats). Records requests only when the
 * `record` test option is set, in a bounded buffer.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = "fake";
  readonly model = "fake-offline";
  /** Recorded requests, oldest first (empty unless the `record` option is set). */
  readonly calls: AiCompletionRequest[] = [];
  private readonly recordMax: number;
  private index = 0;

  constructor(
    private readonly replies: FakeReply[] = ["(fake reply)"],
    options: FakeAiProviderOptions = {},
  ) {
    if (replies.length === 0) throw new Error("FakeAiProvider needs at least one reply");
    this.recordMax = options.record === true ? 50 : typeof options.record === "number" ? Math.max(0, Math.floor(options.record)) : 0;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (this.recordMax > 0) {
      this.calls.push(request);
      if (this.calls.length > this.recordMax) this.calls.splice(0, this.calls.length - this.recordMax);
    }
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)]!;
    if (this.index < this.replies.length) this.index += 1;
    const value = typeof reply === "function" ? reply(request) : reply;
    if (typeof value === "string") return { text: value, provider: this.name };

    const toolCalls: AiToolCallRecord[] = [];
    for (const call of value.toolCalls ?? []) {
      const spec = request.tools?.find((t) => t.name === call.name);
      if (!spec) throw new Error(`fake provider asked for unknown tool ${call.name}`);
      const input = spec.inputSchema.parse(call.input);
      toolCalls.push({ name: call.name, input, output: await spec.execute(input) });
    }
    const text = value.after ? value.after(toolCalls) : value.text;
    return { text, provider: this.name, ...(toolCalls.length ? { toolCalls } : {}) };
  }
}
