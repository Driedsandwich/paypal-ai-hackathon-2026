import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { createApp, type AppOptions } from "../src/server.js";
import { FAKE_CONFIG, fakeEmail, type RecordedCall } from "./helpers/fake-fetch.js";
import { paypalError, paypalWith, SANDBOX } from "./helpers/paypal.js";

let close: (() => Promise<void>) | undefined;
let tmp: string | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

async function start(options: AppOptions = {}) {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => new Promise((resolve) => server.close(() => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const r = await fetch(`${base}${p}`);
    return { status: r.status, headers: r.headers, body: (r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text() };
  };
  const post = async (p: string, body: unknown = {}, headers: Record<string, string> = { "Content-Type": "application/json" }) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: (await r.json()) as any };
  };
  return { base, get, post };
}

const WRITE = (c: RecordedCall) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token");

const TEA_ITEM = { title_ja: "手作り 抹茶碗 陶器", description_ja: "ろくろで作りました。", price_jpy: 12000, condition: "handmade" };
const LISTING = { title: "Handmade Japanese Tea Bowl", description: "Stoneware.", price: { currency_code: "USD", value: "80.00" } };

/** Fake PayPal sandbox that answers every route the app uses. */
function sandbox(overrides: (c: RecordedCall) => { status?: number; json?: unknown } | undefined = () => undefined) {
  return paypalWith((c) => {
    const o = overrides(c);
    if (o) return o;
    const u = c.url.replace(SANDBOX, "");
    if (u.startsWith("/v2/invoicing/invoices?")) {
      return {
        json: {
          total_items: 2,
          items: [
            { id: "INV2-UNPAID", status: "SENT", detail: { currency_code: "USD", invoice_number: "0001", invoice_date: "2026-10-20" }, amount: { currency_code: "USD", value: "80.00" }, items: [{ name: "Tea bowl", quantity: "1", unit_amount: { currency_code: "USD", value: "80.00" } }] },
            { id: "INV2-PAID", status: "PAID", detail: { currency_code: "USD", invoice_number: "0002" }, amount: { currency_code: "USD", value: "40.00" } },
          ],
        },
      };
    }
    if (u === "/v2/invoicing/invoices/INV2-PAID") {
      return { json: { id: "INV2-PAID", status: "PAID", detail: { currency_code: "USD", invoice_number: "0002", invoice_date: "2026-10-15" }, amount: { currency_code: "USD", value: "40.00" }, items: [{ name: "Kokeshi doll", quantity: "1" }], payments: { transactions: [{ payment_id: "8MC585209K746392H", payment_date: "2026-10-16" }] } } };
    }
    if (u === "/v2/invoicing/invoices/INV2-UNPAID") return { json: { id: "INV2-UNPAID", status: "SENT", detail: { currency_code: "USD" } } };
    if (u === "/v2/invoicing/generate-next-invoice-number") return { json: { invoice_number: "0003" } };
    if (u === "/v2/invoicing/invoices" && c.method === "POST") return { status: 201, json: { id: "INV2-NEW", status: "DRAFT" } };
    if (/^\/v2\/invoicing\/invoices\/[^/]+\/send$/.test(u)) return { json: { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-NEW", rel: "payer-view" } };
    if (/^\/v2\/invoicing\/invoices\/[^/]+\/remind$/.test(u)) return { status: 204 };
    if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [{ dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE" }] } };
    if (u === "/v1/customer/disputes/PP-D-1") {
      return { json: { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", dispute_amount: { currency_code: "USD", value: "40.00" }, create_time: "2026-10-28T03:00:00Z", messages: [{ posted_by: "BUYER", content: "Where is my item?" }] } };
    }
    if (u === "/v1/shipping/trackers-batch") return { json: { tracker_identifiers: [{ transaction_id: "8MC585209K746392H" }], errors: [] } };
    if (u === "/v2/checkout/orders" && c.method === "POST") return { json: { id: "O-1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=O-1" }] } };
    return undefined;
  });
}

describe("offline start (AI_PROVIDER=fake, no PayPal variables)", () => {
  it("starts, explains what is missing, and still drafts listings", async () => {
    const { get, post } = await start({ settings: loadSettings({}) });
    const health = await get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.data.paypal.configured).toBe(false);
    expect(health.body.data.ai).toEqual({ provider: "fake", model: "fake-offline" });
    expect(health.body.data.banner.join(" ")).toMatch(/PayPal is not configured/);
    expect(health.body.data.banner.join(" ")).toMatch(/offline demo mode/);

    const draft = await post("/api/listings/draft", { item: TEA_ITEM });
    expect(draft.status).toBe(200);
    expect(draft.body.data.price.usd).toBe("80.00");

    const invoices = await get("/api/invoices");
    expect(invoices.status).toBe(503);
    expect(invoices.body.error.code).toBe("paypal_not_configured");
    expect((await get("/api/demo/items")).body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("serves the built UI with SPA fallback and blocks path traversal", async () => {
    tmp = mkdtempSync(path.join(tmpdir(), "okuri-ui-"));
    writeFileSync(path.join(tmp, "index.html"), "<!doctype html><div id=root></div>");
    writeFileSync(path.join(tmp, "app.js"), "console.log(1)");
    const { get, base } = await start({ staticDir: tmp });
    expect((await get("/")).body).toContain("id=root");
    expect((await get("/invoices")).body).toContain("id=root");
    expect((await get("/app.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await get("/missing.js")).status).toBe(404);
    // Raw requests, so the client does not normalize the dot segments away.
    const port = new URL(base).port;
    for (const p of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/..%2f..%2fetc%2fpasswd"]) {
      const raw = await new Promise<string>((resolve) => {
        const c = net.connect(Number(port), "127.0.0.1", () => c.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
        let d = "";
        c.on("data", (b) => (d += b));
        c.on("end", () => resolve(d));
      });
      expect(raw).not.toMatch(/root:.*:0:0/);
      expect(raw).toMatch(/^HTTP\/1\.1 (403|404|200)/);
    }
  });

  it("shows a hint page when the UI is not built", async () => {
    const { get } = await start();
    expect((await get("/")).body).toMatch(/npm run build/);
  });
});

describe("approval gate over HTTP", () => {
  it("prepare creates a proposal and sends nothing; approve runs it once", async () => {
    const pp = sandbox();
    const { post, get } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client });

    const prepared = await post("/api/invoices/prepare", { listing: LISTING, buyer: { email: fakeEmail("buyer") } });
    expect(prepared.status).toBe(200);
    const proposal = prepared.body.data.proposal;
    expect(proposal).toMatchObject({ kind: "create_and_send_invoice", status: "pending" });
    expect(proposal.payload.invoice.items[0].unit_amount).toEqual({ currency_code: "USD", value: "80.00" });
    expect(pp.calls.filter(WRITE)).toHaveLength(0);

    // A tampered body on approve is ignored: the stored payload runs.
    const approved = await post(`/api/proposals/${proposal.id}/approve`, { payload: { invoice: { items: [] } } });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "executed", result: { invoiceId: "INV2-NEW", invoiceNumber: "0003" } });
    const created = pp.calls.find((c) => c.url === `${SANDBOX}/v2/invoicing/invoices` && c.method === "POST")!;
    expect(JSON.parse(created.body!).items[0].name).toBe("Handmade Japanese Tea Bowl");

    const again = await post(`/api/proposals/${proposal.id}/approve`);
    expect(again.status).toBe(409);
    expect(pp.calls.filter((c) => c.url === `${SANDBOX}/v2/invoicing/invoices` && c.method === "POST")).toHaveLength(1);

    expect((await get("/api/proposals?status=executed")).body.data).toHaveLength(1);
  });

  it("every state-changing route only proposes; rejected and unknown proposals cannot run", async () => {
    const pp = sandbox();
    const { post } = await start({
      paypalConfig: FAKE_CONFIG,
      paypal: pp.client,
      settings: loadSettings({ DEMO_BUYER_EMAILS: `${fakeEmail("b1")},${fakeEmail("b2")}` }),
    });
    const created = [
      await post("/api/tracking", { kind: "invoice", invoice_id: "INV2-PAID", carrier: "Japan Post", tracking_number: "EJ123456789JP" }),
      await post("/api/tracking", { kind: "order", order_id: "O-1", capture_id: "CAP-1", carrier: "Yamato", tracking_number: "1234-5678-9012" }),
      await post("/api/orders/O-1/capture"),
      await post("/api/disputes/PP-D-1/accept-claim", { note: "Refunding in full." }),
      await post("/api/demo/seed"),
      await post("/api/invoices/nudge", {}),
      await post("/api/disputes/PP-D-1/evidence-pack", { invoice_id: "INV2-PAID", tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP", shipped_date: "2026-10-17" } }),
    ];
    for (const r of created) expect([200, 201]).toContain(r.status);
    expect(pp.calls.filter(WRITE)).toHaveLength(0);

    expect(created[0]!.body.data.proposal.payload).toEqual({
      trackers: [{ transaction_id: "8MC585209K746392H", tracking_number: "EJ123456789JP", status: "SHIPPED", carrier: "JPN_JAPAN_POST", notify_buyer: true }],
    });
    expect(created[1]!.body.data.proposal.payload.tracker).toMatchObject({ carrier: "YAMATO", capture_id: "CAP-1" });
    expect(created[4]!.body.data.proposal.payload.invoices).toHaveLength(4);
    expect(created[5]!.body.data.proposals.map((p: any) => p.payload.invoiceId)).toEqual(["INV2-UNPAID"]);
    const pack = created[6]!.body.data;
    expect(pack.pack.unverified_facts).toEqual([]);
    expect(pack.proposals.provide_evidence.kind).toBe("provide_dispute_evidence");
    expect(pack.proposals.send_message.payload.disputeId).toBe("PP-D-1");

    const accept = created[3]!.body.data.proposal;
    expect((await post(`/api/proposals/${accept.id}/reject`)).body.data.status).toBe("rejected");
    expect((await post(`/api/proposals/${accept.id}/approve`)).status).toBe(409);
    expect((await post("/api/proposals/prop_does_not_exist/approve")).status).toBe(404);
    expect(pp.calls.filter(WRITE)).toHaveLength(0);

    const track = created[0]!.body.data.proposal;
    expect((await post(`/api/proposals/${track.id}/approve`)).body.data.status).toBe("executed");
    expect(pp.calls.filter(WRITE).map((c) => c.url.replace(SANDBOX, ""))).toEqual(["/v1/shipping/trackers-batch"]);
  });

  it("order path: prepare proposes a payment link, and the PayPal return page queues a capture for approval", async () => {
    const pp = sandbox();
    const { post, get } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({ PAYMENT_PATH: "order", PUBLIC_BASE_URL: "https://demo.invalid" }) });
    const prepared = await post("/api/invoices/prepare", { listing: LISTING });
    expect(prepared.body.data.path).toBe("order");
    expect(prepared.body.data.proposal.payload.order.payment_source.paypal.experience_context.return_url).toBe("https://demo.invalid/paypal/return");
    const approved = await post(`/api/proposals/${prepared.body.data.proposal.id}/approve`);
    expect(approved.body.data.result).toEqual({ orderId: "O-1", status: "PAYER_ACTION_REQUIRED", payerLink: "https://www.sandbox.paypal.com/checkoutnow?token=O-1" });

    const page = await get("/paypal/return?token=O1TOKEN&PayerID=X");
    expect(page.body).toMatch(/Payment approved/);
    await get("/paypal/return?token=O1TOKEN");
    const captures = (await get("/api/proposals?status=pending")).body.data.filter((p: any) => p.kind === "capture_order");
    expect(captures.map((p: any) => p.payload)).toEqual([{ orderId: "O1TOKEN" }]);
  });

  it("failed executions keep PayPal's debug_id for the seller", async () => {
    const pp = sandbox((c) => (c.url.endsWith("/accept-claim") ? { status: 422, json: paypalError("UNPROCESSABLE_ENTITY", "dbg-77", "DISPUTE_NOT_ELIGIBLE") } : undefined));
    const { post } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const p = (await post("/api/disputes/PP-D-1/accept-claim", { note: "Refund" })).body.data.proposal;
    const res = await post(`/api/proposals/${p.id}/approve`);
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.error.paypal).toMatchObject({ debugId: "dbg-77", status: 422 });
    expect(JSON.stringify(res.body)).not.toMatch(/Bearer|Authorization/);
  });

  it("maps PayPal read errors to { ok:false } with debug_id", async () => {
    const pp = sandbox((c) => (c.url.includes("/v1/customer/disputes?") ? { status: 403, json: paypalError("NOT_AUTHORIZED", "dbg-403") } : undefined));
    const { get } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const res = await get("/api/disputes");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ ok: false, error: { code: "paypal_error", message: "PayPal could not complete the request", paypal: expect.objectContaining({ debugId: "dbg-403", status: 403 }) } });
  });
});

describe("input validation and limits", () => {
  it("validates JSON, content type, sizes and fields", async () => {
    const { post, base } = await start();
    expect((await post("/api/listings/draft", { item: TEA_ITEM }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await post("/api/listings/draft", "{oops")).status).toBe(400);
    const bad = await post("/api/listings/draft", { item: { title_ja: "", price_jpy: -5 } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_input");
    expect(bad.body.error.issues.join(" ")).toMatch(/item\.title_ja/);
    const big = await post("/api/listings/draft", { item: { ...TEA_ITEM, description_ja: "x".repeat(70_000) } });
    expect(big.status).toBe(413);
    const wrongMethod = await fetch(`${base}/api/listings/draft`);
    expect(wrongMethod.status).toBe(405);
  });

  it("rate limits AI routes per IP with a clear message, leaving other routes alone", async () => {
    const { post, get } = await start({ settings: loadSettings({ AI_RATE_LIMIT_PER_IP: "2", AI_RATE_LIMIT_WINDOW_MINUTES: "10" }) });
    expect((await post("/api/listings/draft", { item: TEA_ITEM })).status).toBe(200);
    expect((await post("/api/listings/draft", { item: TEA_ITEM })).status).toBe(200);
    const limited = await post("/api/listings/draft", { item: TEA_ITEM });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(limited.body.error).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/Too many AI requests/) });
    expect((await post("/api/chat", { messages: [{ role: "user", content: "hi" }] })).status).toBe(429);
    expect((await get("/api/health")).status).toBe(200);
  });

  it("enforces the global daily cap", async () => {
    const { post, get } = await start({ settings: loadSettings({ AI_DAILY_CAP: "1" }) });
    expect((await post("/api/chat", { messages: [{ role: "user", content: "hello" }] })).status).toBe(200);
    const capped = await post("/api/listings/draft", { item: TEA_ITEM });
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("daily_cap_reached");
    expect((await get("/api/health")).body.data.limits.usedToday).toBe(1);
  });

  it("rejects bad settings early", () => {
    expect(() => loadSettings({ PAYMENT_PATH: "cash" })).toThrow(/PAYMENT_PATH/);
    expect(() => loadSettings({ AI_DAILY_CAP: "-1" })).toThrow(/AI_DAILY_CAP/);
    expect(loadSettings({ AG_STUDIO_LICENSE: "x" }).agStudioLicensed).toBe(true);
  });
});
