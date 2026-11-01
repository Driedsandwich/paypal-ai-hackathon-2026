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
export * from "./fallback.js";

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

function sdkProvider(name: Exclude<AiProviderName, "fake">, apiKey: string, modelId: string, maxOutputTokens: number, timeoutMs?: number): AiSdkProvider {
  const model =
    name === "anthropic"
      ? createAnthropic({ apiKey })(modelId)
      : name === "google"
        ? createGoogleGenerativeAI({ apiKey })(modelId)
        : createOpenAI({ apiKey })(modelId);
  const providerOptions = providerOptionsFor(name, modelId);
  return new AiSdkProvider(name, modelId, model, { maxOutputTokens, ...(providerOptions ? { providerOptions } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
}

/** The fallback answers within 30 s, so primary (45 s) + fallback stays under about 75 s. */
export const AI_FALLBACK_TIMEOUT_MS = 30_000;

/**
 * Optional second provider from AI_FALLBACK_PROVIDER / AI_FALLBACK_MODEL / AI_FALLBACK_API_KEY.
 * A missing key does not stop the server: the fallback is skipped with a warning.
 */
export function createFallbackProviderFromEnv(env: NodeJS.ProcessEnv = process.env, maxOutputTokens = 2000): { provider?: AiProvider; warning?: string } {
  const raw = (env.AI_FALLBACK_PROVIDER ?? "").trim();
  if (!raw) return {};
  const name = parseAiProviderName(raw);
  if (name === "fake") return { provider: new FakeAiProvider([offlineReply]) };
  const apiKey = (env.AI_FALLBACK_API_KEY ?? "").trim();
  if (!apiKey) return { warning: `AI_FALLBACK_PROVIDER=${name} is set but AI_FALLBACK_API_KEY is empty, so there is no fallback.` };
  const modelId = (env.AI_FALLBACK_MODEL ?? "").trim() || DEFAULT_MODELS[name];
  return { provider: sdkProvider(name, apiKey, modelId, maxOutputTokens, AI_FALLBACK_TIMEOUT_MS) };
}

/** What the server could not set up for AI, in words for the banner and /api/health. */
export interface AiSetupWarnings {
  /** The primary's key is missing: the offline AI answers instead. */
  primary?: string;
  /** The fallback's key is missing: no fallback. */
  fallback?: string;
}

/**
 * Startup version of the two factories above: a missing credential never stops the server.
 * Primary key missing: the offline (rule-based) provider answers and no fallback is used, so
 * every answer comes from one clearly labelled source. Fallback key missing: no fallback.
 * An unknown provider name still throws (a typo should be fixed, not hidden).
 */
export function createAiSetupFromEnv(env: NodeJS.ProcessEnv = process.env, maxOutputTokens = 2000): { ai: AiProvider; fallback?: AiProvider; warnings: AiSetupWarnings } {
  const name = parseAiProviderName(env.AI_PROVIDER);
  const fb = createFallbackProviderFromEnv(env, maxOutputTokens);
  const warnings: AiSetupWarnings = {};
  if (name !== "fake" && !(env.AI_API_KEY ?? "").trim()) {
    warnings.primary = `AI_API_KEY is not set for AI_PROVIDER=${name}, so the offline AI answers (rule-based, not a real model)${fb.provider || fb.warning ? " and the fallback is not used" : ""}.`;
    return { ai: new FakeAiProvider([offlineReply]), warnings };
  }
  if (fb.warning) warnings.fallback = fb.warning;
  return { ai: createAiProviderFromEnv(env, maxOutputTokens), ...(fb.provider ? { fallback: fb.provider } : {}), warnings };
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
  return sdkProvider(name, apiKey, modelId, maxOutputTokens);
}
