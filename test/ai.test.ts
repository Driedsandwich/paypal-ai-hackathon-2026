import { describe, expect, it } from "vitest";
import { createAiProviderFromEnv, FakeAiProvider, HttpAiProvider, type AiProvider } from "../src/ai/index.js";

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

  it("selects the fake provider by default and a real-provider template otherwise", async () => {
    expect(createAiProviderFromEnv({}).name).toBe("fake");
    expect(createAiProviderFromEnv({ AI_PROVIDER: "fake" })).toBeInstanceOf(FakeAiProvider);

    const real = createAiProviderFromEnv({ AI_PROVIDER: "someprovider", AI_API_KEY: "fake-key" });
    expect(real).toBeInstanceOf(HttpAiProvider);
    await expect(real.complete({ messages: [] })).rejects.toThrow(/not implemented/);

    expect(() => createAiProviderFromEnv({ AI_PROVIDER: "someprovider" })).toThrow(/AI_API_KEY/);
  });
});
