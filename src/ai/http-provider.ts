import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "./provider.js";

export interface HttpAiProviderOptions {
  name: string;
  apiKey: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Template for a real provider. No vendor SDK: call the provider's HTTP API
 * with fetch once the provider is chosen.
 */
export class HttpAiProvider implements AiProvider {
  readonly name: string;
  protected readonly apiKey: string;
  protected readonly fetchImpl: NonNullable<HttpAiProviderOptions["fetch"]>;

  constructor(options: HttpAiProviderOptions) {
    if (!options.apiKey) throw new Error("AI_API_KEY is required for a real AI provider");
    this.name = options.name;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async complete(_request: AiCompletionRequest): Promise<AiCompletionResult> {
    // TODO: map the request to the chosen provider's HTTP API and parse its reply.
    throw new Error(`AI provider "${this.name}" is not implemented yet`);
  }
}
