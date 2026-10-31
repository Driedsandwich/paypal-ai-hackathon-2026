import { FakeAiProvider } from "./fake-provider.js";
import { HttpAiProvider } from "./http-provider.js";
import type { AiProvider } from "./provider.js";

export * from "./provider.js";
export * from "./fake-provider.js";
export * from "./http-provider.js";

/** Picks a provider from AI_PROVIDER / AI_API_KEY. Empty or "fake" selects the fake provider. */
export function createAiProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const name = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  if (name === "" || name === "fake") return new FakeAiProvider();
  return new HttpAiProvider({ name, apiKey: env.AI_API_KEY ?? "" });
}
