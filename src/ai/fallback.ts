import { AiBudgetError } from "../limits/rate-limit.js";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "./provider.js";
import { AiTimeoutError } from "./ai-sdk-provider.js";

export type FallbackReason = "budget" | "timeout" | "output_cut_off" | "error";

function reasonOf(err: unknown): FallbackReason {
  if (err instanceof AiBudgetError) return "budget";
  if (err instanceof AiTimeoutError) return "timeout";
  return "error";
}

/**
 * Primary provider with an automatic second one (AI_FALLBACK_PROVIDER). The fallback answers
 * when the primary throws (API error, timeout), its daily budget is used up, or its answer was
 * cut off by the output cap. Both providers are already wrapped with their own daily budget.
 * A chat whose tools already ran on the primary is not repeated on the fallback (a repeat
 * could queue the same proposal twice); the primary's error is raised instead.
 */
export function withFallback(primary: AiProvider, fallback: AiProvider, log: (msg: string) => void = () => {}): AiProvider {
  return {
    name: primary.name,
    ...(primary.model ? { model: primary.model } : {}),
    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      let toolsRan = false;
      const tracked: AiCompletionRequest = request.tools
        ? { ...request, tools: request.tools.map((t) => ({ ...t, execute: async (input: unknown) => ((toolsRan = true), t.execute(input)) })) }
        : request;
      let reason: FallbackReason;
      try {
        const result = await primary.complete(tracked);
        if (result.finishReason !== "length" || toolsRan) return result;
        reason = "output_cut_off";
      } catch (err) {
        if (toolsRan) throw err;
        reason = reasonOf(err);
        log(`AI fallback: ${primary.name} failed (${reason}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}); asking ${fallback.name}`);
      }
      const result = await fallback.complete(request);
      return { ...result, fallbackFrom: { provider: primary.name, ...(primary.model ? { model: primary.model } : {}), reason } };
    },
  };
}
