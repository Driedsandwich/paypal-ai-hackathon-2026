import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { AiSdkProvider, createAiProviderFromEnv, DEFAULT_MODELS, FakeAiProvider, providerOptionsFor, type AiProvider } from "../src/ai/index.js";

/** Example caller written only against the interface. */
async function summarize(ai: AiProvider, text: string): Promise<string> {
  const result = await ai.complete({ messages: [{ role: "system", content: "Summarize." }, { role: "user", content: text }] });
  return result.text;
}

describe("AI provider seam", () => {
  it("fake provider returns scripted replies in order and records calls", async () => {
    const ai = new FakeAiProvider(["first", "second"]);
    expect(await summarize(ai, "a")).toBe("first");
    expect(await summarize(ai, "b")).toBe("second");
    expect(await summarize(ai, "c")).toBe("second");
    expect(ai.calls).toHaveLength(3);
    expect(ai.calls[0]!.messages[1]).toEqual({ role: "user", content: "a" });
  });

  it("fake provider can compute replies from the request", async () => {
    const ai = new FakeAiProvider([(req) => `echo:${req.messages.at(-1)?.content}`]);
    const result = await ai.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(result).toEqual({ text: "echo:hi", provider: "fake" });
  });

  it("selects the offline fake by default and real providers by name", () => {
    expect(createAiProviderFromEnv({}).name).toBe("fake");
    expect(createAiProviderFromEnv({ AI_PROVIDER: "fake" })).toBeInstanceOf(FakeAiProvider);

    const anthropic = createAiProviderFromEnv({ AI_PROVIDER: "anthropic", AI_API_KEY: "fake-key" });
    expect(anthropic).toBeInstanceOf(AiSdkProvider);
    expect(anthropic.model).toBe(DEFAULT_MODELS.anthropic);
    expect(createAiProviderFromEnv({ AI_PROVIDER: "google", AI_API_KEY: "fake-key", AI_MODEL: "custom-model" }).model).toBe("custom-model");
    expect(createAiProviderFromEnv({ AI_PROVIDER: "OpenAI", AI_API_KEY: "fake-key" }).name).toBe("openai");

    expect(() => createAiProviderFromEnv({ AI_PROVIDER: "anthropic" })).toThrow(/AI_API_KEY/);
    expect(providerOptionsFor("anthropic", "claude-opus-5-5")).toEqual({ anthropic: { effort: "low", fallbacks: "default" } });
    expect(providerOptionsFor("anthropic", "claude-haiku-5-5")).toEqual({ anthropic: { effort: "low" } });
    expect(providerOptionsFor("google", "gemini-3.5-flash")).toBeUndefined();
    expect(() => createAiProviderFromEnv({ AI_PROVIDER: "someprovider", AI_API_KEY: "k" })).toThrow(/AI_PROVIDER must be one of/);
  });

  it("AI SDK provider passes system/messages/token cap and runs tools with real schemas", async () => {
    const seen: Array<{ tools?: unknown; maxOutputTokens?: number; prompt: unknown; providerOptions?: unknown }> = [];
    let step = 0;
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV3({
      doGenerate: async (opts) => {
        seen.push({ tools: opts.tools, maxOutputTokens: opts.maxOutputTokens, prompt: opts.prompt, providerOptions: opts.providerOptions });
        step += 1;
        return step === 1
          ? { content: [{ type: "tool-call", toolCallId: "c1", toolName: "lookup", input: JSON.stringify({ id: "INV2-1" }) }], finishReason: { unified: "tool-calls", raw: undefined }, usage, warnings: [] }
          : { content: [{ type: "text", text: "Invoice INV2-1 is SENT." }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
      },
    });
    const ai = new AiSdkProvider("anthropic", "test-model", model, { maxOutputTokens: 500, providerOptions: { anthropic: { effort: "low" } } });
    const result = await ai.complete({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "status?" },
      ],
      maxTokens: 9999,
      tools: [{ name: "lookup", description: "Look up", inputSchema: z.object({ id: z.string() }), execute: async (i) => ({ status: "SENT", ...(i as object) }) }],
    });
    expect(result.text).toBe("Invoice INV2-1 is SENT.");
    expect(result.toolCalls).toEqual([{ name: "lookup", input: { id: "INV2-1" }, output: { status: "SENT", id: "INV2-1" } }]);
    expect(seen[0]!.maxOutputTokens).toBe(500);
    expect(seen[0]!.providerOptions).toEqual({ anthropic: { effort: "low" } });
    const sentTool = (seen[0]!.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>)[0]!;
    expect(sentTool.name).toBe("lookup");
    expect(Object.keys(sentTool.inputSchema.properties)).toEqual(["id"]); // not the empty schema the toolkit produces
    expect((seen[0]!.prompt as Array<{ role: string }>)[0]!.role).toBe("system");
  });
});
