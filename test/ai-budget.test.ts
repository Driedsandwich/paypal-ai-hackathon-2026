import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { withAiBudget } from "../src/ai/budget.js";
import { AiSdkProvider, FakeAiProvider } from "../src/ai/index.js";
import { offlineReply } from "../src/ai/offline.js";
import { Agent } from "../src/agent/tasks.js";
import { loadSettings } from "../src/config.js";
import { AiBudgetError, AiLimiter } from "../src/limits/rate-limit.js";
import { FAKE_CONFIG } from "./helpers/fake-fetch.js";
import { startApp } from "./helpers/http.js";
import { paypalWith } from "./helpers/paypal.js";

const TEA_ITEM = { title_ja: "手作り 抹茶碗 陶器", description_ja: "ろくろで作りました。", price_jpy: 12000, condition: "handmade" as const };
const limiter = (dailyCap: number) => new AiLimiter({ perIpMax: 100, windowMs: 600_000, dailyCap });

describe("every model call counts against the daily AI budget (F9)", () => {
  it("a JSON repair retry costs two model calls", async () => {
    const good = JSON.stringify({ title: "Japanese Tea Bowl", description: "A handmade tea bowl from Japan.", item_specifics: [], customs_description: "ceramic tea bowl", hs_code_candidate: "6912.00" });
    const l = limiter(10);
    const ai = withAiBudget(new FakeAiProvider(["{not json", good]), l);
    await new Agent(ai, { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "http://localhost" }).draftListing({ ...TEA_ITEM, description_ja: "x" });
    expect(l.usage().usedToday).toBe(2);
  });

  it("a retry that would exceed the budget is refused", async () => {
    const l = limiter(1);
    const ai = withAiBudget(new FakeAiProvider(["{not json"]), l);
    const err = await new Agent(ai, { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "http://localhost" }).draftListing({ ...TEA_ITEM, description_ja: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBudgetError);
    expect(l.usage().usedToday).toBe(1);
  });

  it("AI SDK: each tool step is debited before it runs; a chat that runs out stops early with a note", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const toolStep = { content: [{ type: "tool-call" as const, toolCallId: "c", toolName: "lookup", input: "{}" }], finishReason: { unified: "tool-calls" as const, raw: undefined }, usage, warnings: [] };
    const textStep = { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] };
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => (++calls < 3 ? toolStep : textStep) });
    const tools = [{ name: "lookup", description: "x", inputSchema: z.object({}), execute: async () => ({ ok: true }) }];
    const messages = [{ role: "user" as const, content: "hi" }];

    const roomy = limiter(10);
    const full = await withAiBudget(new AiSdkProvider("anthropic", "m", model, { maxOutputTokens: 100 }), roomy).complete({ messages, tools, maxSteps: 5 });
    expect(full.text).toBe("done");
    expect(roomy.usage().usedToday).toBe(3);

    calls = 0;
    const tight = limiter(2);
    const short = await withAiBudget(new AiSdkProvider("anthropic", "m", model, { maxOutputTokens: 100 }), tight).complete({ messages, tools, maxSteps: 5 });
    expect(calls).toBe(2);
    expect(tight.usage().usedToday).toBe(2);
    expect(short.text).toMatch(/Stopped early: the demo's daily AI limit was reached/);
  });
});

describe("budget refusal through the real AI SDK provider", () => {
  it("a refused first step surfaces as AiBudgetError (so the API answers 429, not 502)", async () => {
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => (modelCalls++, { content: [{ type: "text" as const, text: "x" }], finishReason: { unified: "stop" as const, raw: undefined }, usage, warnings: [] }),
    });
    const spent = limiter(1);
    spent.debitModelCall();
    const err = await withAiBudget(new AiSdkProvider("anthropic", "m", model, { maxOutputTokens: 10 }), spent).complete({ messages: [{ role: "user", content: "hi" }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiBudgetError);
    expect(modelCalls).toBe(0);
  });
});

describe("AI limits over HTTP (F9)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  async function start(env: Record<string, string>, extra: Parameters<typeof startApp>[0] = {}) {
    const app = await startApp({ settings: loadSettings(env), ...extra });
    close = app.close;
    return app;
  }

  it("invalid input is validated before anything is debited", async () => {
    const { post, get } = await start({ AI_RATE_LIMIT_PER_IP: "1", AI_DAILY_CAP: "5" });
    expect((await post("/api/listings/draft", { item: { title_ja: "" } })).status).toBe(400);
    expect((await post("/api/listings/draft", "{oops")).status).toBe(400);
    expect((await get("/api/health")).body.data.limits.usedToday).toBe(0);
    expect((await post("/api/listings/draft", { item: TEA_ITEM })).status).toBe(200); // allowance still there
    expect((await get("/api/health")).body.data.limits.usedToday).toBe(1);
  });

  it("a JSON retry that would exceed the daily budget answers 429 daily_cap_reached", async () => {
    const { post } = await start({ AI_DAILY_CAP: "1" }, { ai: new FakeAiProvider(["{not json"]) });
    const res = await post("/api/listings/draft", { item: TEA_ITEM });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("daily_cap_reached");
  });

  it("refuses an address that keeps sending invalid AI requests", async () => {
    const { post } = await start({ AI_INVALID_RATE_LIMIT_PER_IP: "2" });
    for (let i = 0; i < 2; i++) expect((await post("/api/chat", { messages: [] })).status).toBe(400);
    const refused = await post("/api/chat", { messages: [{ role: "user", content: "hello" }] });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("too_many_invalid_requests");
  });

  it("a chat with a tool step uses two model calls", async () => {
    const pp = paypalWith((c) => (c.url.includes("/v2/invoicing/invoices?") ? { json: { items: [] } } : undefined));
    const { post, get } = await start({ AI_DAILY_CAP: "10" }, { ai: new FakeAiProvider([offlineReply]), paypal: pp.client, paypalConfig: FAKE_CONFIG });
    const res = await post("/api/chat", { messages: [{ role: "user", content: "show my invoices" }] });
    expect(res.body.data.tool_calls.map((c: any) => c.name)).toEqual(["list_invoices"]);
    expect((await get("/api/health")).body.data.limits.usedToday).toBe(2);
  });
});
