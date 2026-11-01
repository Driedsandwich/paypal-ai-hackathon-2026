import type { AddressInfo } from "node:net";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { AiSdkProvider, AiTimeoutError, type AiProvider } from "../src/ai/index.js";
import { loadSettings } from "../src/config.js";
import { PayPalClient, PayPalTimeoutError, type FetchLike } from "../src/paypal/client.js";
import { ProposalObsoleteError, ProposalStore } from "../src/proposals/store.js";
import { createApp, describeExecutionError, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, type AppOptions } from "../src/server.js";
import { createFakeFetch, FAKE_CONFIG, fakeEmail } from "./helpers/fake-fetch.js";
import { visitor } from "./helpers/http.js";

/** A fetch that never answers on its own; it rejects only when its signal aborts. */
function hangingFetch(answer: (url: string) => boolean = () => false): FetchLike {
  const normal = createFakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? { json: { access_token: "fake-access-token", expires_in: 3600 } } : { json: {} })).fetch;
  return (url, init) => {
    if (url.endsWith("/v1/oauth2/token") || answer(url)) return normal(url, init);
    return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function start(options: AppOptions) {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("PayPal call deadline", () => {
  it("aborts a slow call and tells writes from reads", async () => {
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch: hangingFetch(), timeoutMs: 20 });
    const read = (await client.getInvoice("INV2-1").catch((e: unknown) => e)) as PayPalTimeoutError;
    expect(read).toBeInstanceOf(PayPalTimeoutError);
    expect(read).toMatchObject({ method: "GET", write: false });
    const write = (await client.createDraftInvoice({ detail: { currency_code: "USD" }, items: [] }).catch((e: unknown) => e)) as PayPalTimeoutError;
    expect(write).toMatchObject({ method: "POST", path: "/v2/invoicing/invoices", write: true });
    expect(((await client.generateNextInvoiceNumber().catch((e: unknown) => e)) as PayPalTimeoutError).write).toBe(false);
  });

  it("aborts a slow token request too", async () => {
    const fetch: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const err = (await new PayPalClient({ config: FAKE_CONFIG, fetch, timeoutMs: 20 }).getAccessToken().catch((e: unknown) => e)) as PayPalTimeoutError;
    expect(err).toMatchObject({ name: "PayPalTimeoutError", write: false });
  });
});

describe("unknown and obsolete outcomes", () => {
  it("a timed-out write becomes 'unknown' (not failed, not retried); a timed-out read stays 'failed'", async () => {
    const store = new ProposalStore(
      async (kind) => {
        throw new PayPalTimeoutError(kind === "capture_order" ? "POST" : "GET", "/x", 15_000);
      },
      { describeError: (e) => describeExecutionError(e), isUnknownOutcome: (e) => e instanceof PayPalTimeoutError && e.write },
    );
    const w = await store.approve(store.propose("capture_order", "Capture", { orderId: "O1" }, { owner: "me" }).id, "me");
    expect(w.status).toBe("unknown");
    expect(w.error).toMatchObject({ needsCheck: true, message: expect.stringMatching(/may or may not have happened/) });
    await expect(store.approve(w.id, "me")).rejects.toMatchObject({ code: "not_pending" });
    const r = await store.approve(store.propose("send_dispute_message", "Reply", { disputeId: "D", message: "m" }, { owner: "me" }).id, "me");
    expect(r.status).toBe("failed");
    expect(r.error).toMatchObject({ message: expect.stringMatching(/Nothing was changed/) });
  });

  it("an obsolete action is marked 'obsolete' with its message", async () => {
    const store = new ProposalStore(async () => {
      throw new ProposalObsoleteError("This dispute no longer accepts messages.");
    });
    const p = await store.approve(store.propose("send_dispute_message", "Reply", { disputeId: "D", message: "m" }, { owner: "me" }).id, "me");
    expect(p).toMatchObject({ status: "obsolete", error: { message: "This dispute no longer accepts messages." } });
  });

  it("internal error messages are not shown verbatim", () => {
    expect(describeExecutionError(new Error("secret internal detail"))).toEqual({ message: "The action could not be completed (internal error)." });
  });

  it("over HTTP, a PayPal write that times out shows 'unknown: needs checking'", async () => {
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch: hangingFetch((u) => u.endsWith("/generate-next-invoice-number")), timeoutMs: 30 });
    const base = await start({ paypalConfig: FAKE_CONFIG, paypal: client, settings: loadSettings({ PAYMENT_PATH: "order", DEMO_BUYER_EMAILS: fakeEmail("b1") }) });
    const me = visitor(base);
    const prepared = (await me.post("/api/invoices/prepare", { listing: { title: "Tea bowl", price: { currency_code: "USD", value: "80.00" } }, buyer: { alias: "Demo buyer 1" } })).body;
    const approved = (await me.post(`/api/proposals/${prepared.data.proposal.id}/approve`)).body;
    expect(approved.data.status).toBe("unknown");
    expect(approved.data.error.needsCheck).toBe(true);
  });
});

describe("AI call deadline", () => {
  it("aborts a model call that takes too long", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: (opts) => new Promise((_, reject) => opts.abortSignal?.addEventListener("abort", () => reject(opts.abortSignal!.reason))),
    });
    const ai = new AiSdkProvider("anthropic", "test-model", model, { maxOutputTokens: 100, timeoutMs: 20 });
    await expect(ai.complete({ messages: [{ role: "user", content: "hi" }] })).rejects.toBeInstanceOf(AiTimeoutError);

    const base = await start({ ai });
    const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    expect(res.status).toBe(504);
    expect(((await res.json()) as any).error.code).toBe("ai_timeout");
  });
});

describe("server limits", () => {
  it("sets header and request timeouts", () => {
    const server = createApp();
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect([HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS]).toEqual([20_000, 30_000]);
  });

  it("caps concurrent in-flight API requests; health stays available", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowAi: AiProvider = { name: "fake", complete: async () => (await gate, { text: "ok", provider: "fake" }) };
    const base = await start({ ai: slowAi, settings: loadSettings({ MAX_CONCURRENT_REQUESTS: "1" }) });
    const chat = () => fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    const first = chat();
    await new Promise((r) => setTimeout(r, 50));
    const second = await chat();
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("2");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await chat()).status).toBe(200);
  });
});
