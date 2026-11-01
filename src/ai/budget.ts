import type { AiLimiter } from "../limits/rate-limit.js";
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from "./provider.js";

/**
 * Wraps a provider so that every model call (each chat tool step, each JSON repair retry) is
 * debited from the daily AI budget before it happens (F9). A chat that runs out of budget
 * between tool steps stops early with a note instead of failing.
 */
export function withAiBudget(inner: AiProvider, limiter: AiLimiter): AiProvider {
  return {
    name: inner.name,
    ...(inner.model ? { model: inner.model } : {}),
    async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
      let stopped = false;
      const result = await inner.complete({
        ...request,
        onModelCall: () => {
          limiter.debitModelCall();
          request.onModelCall?.();
        },
        canContinue: () => {
          const ok = limiter.hasBudget() && (request.canContinue?.() ?? true);
          if (!ok) stopped = true;
          return ok;
        },
      });
      if (!stopped) return result;
      const note = "(Stopped early: the demo's daily AI limit was reached.)";
      return { ...result, text: result.text ? `${result.text}\n\n${note}` : note };
    },
  };
}
