import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "./provider.js";

export type FakeReply = string | ((request: AiCompletionRequest) => string);

/**
 * Deterministic provider for tests and offline demos.
 * Returns scripted replies in order (the last one repeats) and records every request.
 */
export class FakeAiProvider implements AiProvider {
  readonly name = "fake";
  readonly calls: AiCompletionRequest[] = [];
  private index = 0;

  constructor(private readonly replies: FakeReply[] = ["(fake reply)"]) {
    if (replies.length === 0) throw new Error("FakeAiProvider needs at least one reply");
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    this.calls.push(request);
    const reply = this.replies[Math.min(this.index, this.replies.length - 1)]!;
    this.index += 1;
    const text = typeof reply === "function" ? reply(request) : reply;
    return { text, provider: this.name };
  }
}
