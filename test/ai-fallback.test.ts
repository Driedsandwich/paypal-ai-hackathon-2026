import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeAiProvider, withFallback, type AiCompletionRequest, type AiProvider } from "../src/ai/index.js";
import { offlineReply } from "../src/ai/offline.js";
import { AiTimeoutError } from "../src/ai/ai-sdk-provider.js";
import { Agent } from "../src/agent/tasks.js";
import { loadSettings } from "../src/config.js";
import { startApp } from "./helpers/http.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const CONFIG = { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "http://localhost:3000" };
const ITEM = { title_ja: "手作り 抹茶碗", description_ja: "", price_jpy: 12000 };

/** A provider that always fails the same way. */
function failing(name: string, err: Error | "length"): AiProvider & { calls: number } {
  const p = {
    name,
    model: `${name}-model`,
    calls: 0,
    async complete(req: AiCompletionRequest) {
      p.calls += 1;
      req.onModelCall?.();
      if (err === "length") return { text: '{"title": "cut', provider: name, model: `${name}-model`, finishReason: "length" };
      throw err;
    },
  };
  return p;
}

const fallbackFake = () => {
  const f = new FakeAiProvider([offlineReply]);
  return { name: "google", model: "gemini-test", complete: (r: AiCompletionRequest) => f.complete(r).then((x) => ({ ...x, provider: "google", model: "gemini-test" })) } satisfies AiProvider;
};

describe("AI fallback provider", () => {
  it.each([
    ["error", new Error("529 overloaded")],
    ["timeout", new AiTimeoutError(45_000)],
    ["output_cut_off", "length" as const],
  ])("answers with the fallback when the primary fails (%s) and says so", async (reason, err) => {
    const primary = failing("anthropic", err);
    const agent = new Agent(withFallback(primary, fallbackFake()), CONFIG);
    const listing = await agent.draftListing(ITEM);
    expect(listing.generated_by).toEqual({ provider: "google", model: "gemini-test", fallback_from: { provider: "anthropic", model: "anthropic-model", reason } });
  });

  it("does not repeat a chat on the fallback after tools ran on the primary", async () => {
    let executed = 0;
    const primary: AiProvider = {
      name: "anthropic",
      async complete(req) {
        await req.tools![0]!.execute({});
        throw new Error("failed after a tool call");
      },
    };
    const fb = { name: "google", calls: 0, async complete() { fb.calls += 1; return { text: "x", provider: "google" }; } };
    const ai = withFallback(primary, fb);
    await expect(ai.complete({ messages: [], tools: [{ name: "t", description: "", inputSchema: z.object({}), execute: async () => ++executed }] })).rejects.toThrow(/after a tool call/);
    expect(executed).toBe(1);
    expect(fb.calls).toBe(0);
  });

  it("takes over when the primary's daily budget is used up, then both caps apply", async () => {
    const app = await startApp({
      settings: loadSettings({ AI_DAILY_CAP: "1", AI_FALLBACK_DAILY_CAP: "1" }),
      ai: new FakeAiProvider([offlineReply]),
      aiFallback: fallbackFake(),
    });
    close = app.close;
    const health = (await app.get("/api/health")).body.data;
    expect(health.ai).toMatchObject({ provider: "fake", fallback: { provider: "google", model: "gemini-test" } });

    const first = await app.post("/api/listings/draft", { item: ITEM });
    expect(first.body.data.generated_by.provider).toBe("fake");
    const second = await app.post("/api/listings/draft", { item: ITEM });
    expect(second.status).toBe(200);
    expect(second.body.data.generated_by).toMatchObject({ provider: "google", fallback_from: { provider: "fake", reason: "budget" } });
    const third = await app.post("/api/listings/draft", { item: ITEM });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("daily_cap_reached");
    expect((await app.get("/api/health")).body.data.limits).toMatchObject({ usedToday: 1, fallback: { usedToday: 1, dailyCap: 1 } });
  });
});
