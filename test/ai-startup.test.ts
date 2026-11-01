import { afterEach, describe, expect, it } from "vitest";
import { AiSdkProvider, createAiSetupFromEnv, FakeAiProvider } from "../src/ai/index.js";
import { loadSettings } from "../src/config.js";
import { startApp } from "./helpers/http.js";

// Pass 4, item 1: a missing AI credential must not stop the server at startup.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const ITEM = { title_ja: "手作り 抹茶碗", description_ja: "", price_jpy: 12000 };

describe("AI setup at startup", () => {
  it("primary key missing: offline AI, no fallback, a warning (no throw)", () => {
    const setup = createAiSetupFromEnv({ AI_PROVIDER: "anthropic", AI_FALLBACK_PROVIDER: "google", AI_FALLBACK_API_KEY: "fake-key" });
    expect(setup.ai).toBeInstanceOf(FakeAiProvider);
    expect(setup.fallback).toBeUndefined();
    expect(setup.warnings.primary).toMatch(/AI_API_KEY is not set for AI_PROVIDER=anthropic.*offline AI.*fallback is not used/);
    expect(setup.warnings.fallback).toBeUndefined();
    // A blank key counts as missing.
    expect(createAiSetupFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "  " }).ai).toBeInstanceOf(FakeAiProvider);
  });

  it("fallback key missing: the primary runs without a fallback", () => {
    const setup = createAiSetupFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "google" });
    expect(setup.ai).toBeInstanceOf(AiSdkProvider);
    expect(setup.ai.name).toBe("anthropic");
    expect(setup.fallback).toBeUndefined();
    expect(setup.warnings).toEqual({ fallback: expect.stringMatching(/AI_FALLBACK_API_KEY is empty, so there is no fallback/) });
    // A blank fallback key counts as missing too.
    const blank = createAiSetupFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "google", AI_FALLBACK_API_KEY: "  " });
    expect(blank.fallback).toBeUndefined();
    expect(blank.warnings.fallback).toMatch(/AI_FALLBACK_API_KEY is empty/);
  });

  it("both keys set: primary and fallback, no warnings; offline AI needs no key", () => {
    const setup = createAiSetupFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "fake-key", AI_FALLBACK_PROVIDER: "google", AI_FALLBACK_API_KEY: "fake-key" });
    expect(setup.ai.name).toBe("anthropic");
    expect(setup.fallback?.name).toBe("google");
    expect(setup.warnings).toEqual({});
    expect(createAiSetupFromEnv({}).warnings).toEqual({});
    expect(() => createAiSetupFromEnv({ AI_PROVIDER: "someprovider" })).toThrow(/AI_PROVIDER must be one of/);
  });

  it("primary key missing: the app starts, shows a banner, says so in /api/health and still answers", async () => {
    const setup = createAiSetupFromEnv({ AI_PROVIDER: "anthropic" });
    const app = await startApp({ settings: loadSettings({}), ai: setup.ai, aiWarnings: setup.warnings });
    close = app.close;
    const health = (await app.get("/api/health")).body.data;
    expect(health.ai).toMatchObject({ provider: "fake", configured: false, warnings: [expect.stringMatching(/AI_API_KEY is not set/)] });
    expect(health.banner).toContainEqual(expect.stringMatching(/^AI is not configured: AI_API_KEY is not set for AI_PROVIDER=anthropic.*Set the key and restart\.$/));
    expect(health.banner.join(" ")).not.toMatch(/AI_PROVIDER=fake/);
    expect(health.banner.join(" ")).toMatch(/PayPal is not configured/); // same banner list as PayPal's notice
    const draft = await app.post("/api/listings/draft", { item: ITEM });
    expect(draft.status).toBe(200);
    expect(draft.body.data.generated_by.provider).toBe("fake");
  });

  it("fallback key missing: /api/health says there is no fallback", async () => {
    const setup = createAiSetupFromEnv({ AI_PROVIDER: "fake", AI_FALLBACK_PROVIDER: "google" });
    const app = await startApp({ settings: loadSettings({}), ai: setup.ai, ...(setup.fallback ? { aiFallback: setup.fallback } : {}), aiWarnings: setup.warnings });
    close = app.close;
    const health = (await app.get("/api/health")).body.data;
    expect(health.ai.fallback).toBeUndefined();
    expect(health.ai.configured).toBeUndefined();
    expect(health.ai.warnings).toEqual([expect.stringMatching(/AI_FALLBACK_API_KEY is empty, so there is no fallback/)]);
  });
});
