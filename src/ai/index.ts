import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { AiSdkProvider } from "./ai-sdk-provider.js";
import { FakeAiProvider } from "./fake-provider.js";
import { offlineReply } from "./offline.js";
import type { AiProvider } from "./provider.js";

export * from "./provider.js";
export * from "./fake-provider.js";
export * from "./ai-sdk-provider.js";

export const AI_PROVIDERS = ["anthropic", "google", "openai", "fake"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** Default model per provider; AI_MODEL overrides. */
export const DEFAULT_MODELS: Record<Exclude<AiProviderName, "fake">, string> = {
  anthropic: "claude-opus-5-5",
  google: "gemini-3.5-flash",
  openai: "gpt-5.4-mini",
};

/** Claude models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const ANTHROPIC_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/**
 * Provider-specific options. Anthropic: low effort (short, well-specified tasks; thinking
 * tokens count toward the output cap) and, where supported, server-side fallback when a
 * request is declined by a safety classifier.
 */
export function providerOptionsFor(name: AiProviderName, modelId: string) {
  if (name !== "anthropic") return undefined;
  return { anthropic: { effort: "low" as const, ...(ANTHROPIC_FALLBACK_MODELS.has(modelId) ? { fallbacks: "default" as const } : {}) } };
}

export function parseAiProviderName(value: string | undefined): AiProviderName {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return "fake";
  if ((AI_PROVIDERS as readonly string[]).includes(v)) return v as AiProviderName;
  throw new Error(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(", ")} (got "${value}")`);
}

/**
 * Picks a provider from AI_PROVIDER / AI_MODEL / AI_API_KEY.
 * Empty or "fake" selects the offline provider, which needs no key and no network.
 */
export function createAiProviderFromEnv(env: NodeJS.ProcessEnv = process.env, maxOutputTokens = 2000): AiProvider {
  const name = parseAiProviderName(env.AI_PROVIDER);
  if (name === "fake") return new FakeAiProvider([offlineReply]);
  const apiKey = env.AI_API_KEY ?? "";
  if (!apiKey) throw new Error(`AI_API_KEY is required for AI_PROVIDER=${name}`);
  const modelId = (env.AI_MODEL ?? "").trim() || DEFAULT_MODELS[name];
  const model =
    name === "anthropic"
      ? createAnthropic({ apiKey })(modelId)
      : name === "google"
        ? createGoogleGenerativeAI({ apiKey })(modelId)
        : createOpenAI({ apiKey })(modelId);
  const providerOptions = providerOptionsFor(name, modelId);
  return new AiSdkProvider(name, modelId, model, { maxOutputTokens, ...(providerOptions ? { providerOptions } : {}) });
}
