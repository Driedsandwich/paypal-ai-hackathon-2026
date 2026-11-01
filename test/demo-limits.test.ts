import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { DemoLimits, writeCost } from "../src/limits/demo-limits.js";
import { DailyCounter, LimitError, Semaphore, SlidingWindowLimiter } from "../src/limits/limits.js";
import { PayPalClient, type FetchLike } from "../src/paypal/client.js";
import { createFakeFetch, FAKE_CONFIG, fakeEmail, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp, visitor } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

const LISTING = { title: "Handmade Japanese Tea Bowl", description: "Stoneware.", price: { currency_code: "USD", value: "80.00" } };
const BUYERS = { DEMO_BUYER_EMAILS: `${fakeEmail("b1")},${fakeEmail("b2")}` };
const WRITE = (c: RecordedCall) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token");

describe("limit primitives", () => {
  it("sliding window counts per key and tells how long to wait", () => {
    let now = 0;
    const w = new SlidingWindowLimiter(2, 60_000, () => now);
    expect(w.waitSeconds("a", 3)).toBe(60);
    w.record("a");
    now = 10_000;
    w.record("a");
    expect(w.waitSeconds("a")).toBe(50);
    expect(w.waitSeconds("b")).toBe(0);
    now = 60_001;
    expect(w.waitSeconds("a")).toBe(0);
  });

  it("daily counter takes all-or-nothing, refunds and resets at 00:00 UTC", () => {
    let now = Date.parse("2026-11-01T23:00:00Z");
    const d = new DailyCounter(5, () => now);
    expect([d.tryTake(3), d.tryTake(3), d.tryTake(2)]).toEqual([true, false, true]);
    d.refund(1);
    expect(d.remaining()).toBe(1);
    expect(d.secondsUntilReset()).toBe(3600);
    now = Date.parse("2026-11-02T00:00:00Z");
    expect(d.used()).toBe(0);
  });

  it("semaphore refuses without queueing; release is idempotent", () => {
    const s = new Semaphore(2);
    const a = s.tryAcquire()!;
    const b = s.tryAcquire()!;
    expect(s.tryAcquire()).toBeUndefined();
    a();
    a();
    expect(s.active).toBe(1);
    expect(s.tryAcquire()).toBeDefined();
    b();
  });

  it("DemoLimits uses the configured values", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const limits = new DemoLimits(loadSettings({ PROPOSAL_RATE_LIMIT: "2", SEED_DAILY_CAP: "1", SEED_SESSION_INTERVAL_MINUTES: "60" }), () => now);
    limits.takeProposals("s1", "1.1.1.1", 2);
    expect(() => limits.takeProposals("s1", "2.2.2.2")).toThrow(expect.objectContaining({ code: "proposal_rate_limited" }));
    expect(() => limits.takeProposals("s2", "1.1.1.1")).toThrow(LimitError); // same address, new session
    limits.takeProposals("s2", "2.2.2.2");
    limits.takeSeed("s1");
    expect(() => limits.checkSeed("s1")).toThrow(expect.objectContaining({ code: "seed_rate_limited" }));
    expect(() => limits.checkSeed("s2")).toThrow(expect.objectContaining({ code: "seed_daily_cap" }));
    now += 24 * 3_600_000;
    expect(() => limits.checkSeed("s1")).not.toThrow();
  });

  it("counts PayPal write calls per proposal kind", () => {
    expect(writeCost("create_and_send_invoice", {})).toBe(3);
    expect(writeCost("send_invoice_reminder", {})).toBe(1);
    expect(writeCost("seed_demo_data", { invoices: [1, 2, 3, 4] })).toBe(12);
    expect(writeCost("seed_demo_data", { orders: [1, 2, 3, 4] })).toBe(4);
  });
});

function sandbox(route: (c: RecordedCall) => { status?: number; json?: unknown } | undefined = () => undefined) {
  return paypalWith((c) => {
    const o = route(c);
    if (o) return o;
    const u = c.url.replace(SANDBOX, "");
    if (u.startsWith("/v2/invoicing/invoices?")) return { json: { total_items: 1, items: [{ id: "INV2-1", status: "SENT", detail: { currency_code: "USD", invoice_number: "0001" } }] } };
    if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [] } };
    if (u === "/v2/invoicing/generate-next-invoice-number") return { json: { invoice_number: "0009" } };
    if (u === "/v2/invoicing/invoices" && c.method === "POST") return { status: 201, json: { id: "INV2-NEW" } };
    if (u.endsWith("/send")) return { json: { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-NEW", rel: "payer-view" } };
    if (u === "/v1/notifications/verify-webhook-signature") return { json: { verification_status: "SUCCESS" } };
    return undefined;
  });
}

describe("limits over HTTP (F2)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  async function start(env: Record<string, string>, pp = sandbox()) {
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({ ...BUYERS, ...env }) });
    close = app.close;
    return { ...app, pp, other: () => visitor(app.base) };
  }

  it("limits proposal creation per session and per address", async () => {
    const { post, other } = await start({ PROPOSAL_RATE_LIMIT: "2" });
    for (let i = 0; i < 2; i++) expect((await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).status).toBe(200);
    const third = await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("proposal_rate_limited");
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    // A fresh cookie from the same address does not reset the limit.
    expect((await other().post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).status).toBe(429);
  });

  it("limits approvals and leaves refused proposals pending", async () => {
    const { post, get } = await start({ APPROVAL_RATE_LIMIT: "1" });
    const a = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    const b = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 2" } })).body.data.proposal;
    expect((await post(`/api/proposals/${a.id}/approve`)).body.data.status).toBe("executed");
    const refused = await post(`/api/proposals/${b.id}/approve`);
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe("approval_rate_limited");
    expect((await get("/api/proposals?status=pending")).body.data.map((p: any) => p.id)).toEqual([b.id]);
  });

  it("caps PayPal writes per day for the whole server, before any write starts", async () => {
    const { post, pp, get } = await start({ PAYPAL_DAILY_WRITE_CAP: "4" });
    const a = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    const b = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 2" } })).body.data.proposal;
    expect((await post(`/api/proposals/${a.id}/approve`)).body.data.status).toBe("executed");
    const writesBefore = pp.calls.filter(WRITE).length;
    const capped = await post(`/api/proposals/${b.id}/approve`);
    expect(capped.status).toBe(429);
    expect(capped.body.error).toMatchObject({ code: "paypal_daily_write_cap", message: expect.stringMatching(/1 left/) });
    expect(pp.calls.filter(WRITE).length).toBe(writesBefore);
    expect((await get("/api/health")).body.data.demoLimits).toMatchObject({ paypalWritesToday: 3, paypalDailyWriteCap: 4 });
  });

  it("approving an expired proposal does not use up any limit", async () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const { ProposalStore } = await import("../src/proposals/store.js");
    const { createPayPalExecutor } = await import("../src/proposals/actions.js");
    const { DemoBuyers } = await import("../src/demo/buyers.js");
    const pp = sandbox();
    const proposals = new ProposalStore(createPayPalExecutor(() => pp.client, { buyers: new DemoBuyers([fakeEmail("b1")]) }), { now: () => new Date(now) });
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, proposals, settings: loadSettings({ ...BUYERS, PAYPAL_DAILY_WRITE_CAP: "3" }) });
    close = app.close;
    const p = (await app.post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    now += 25 * 3_600_000;
    const res = await app.post(`/api/proposals/${p.id}/approve`);
    expect(res.status).toBe(409);
    expect((await app.get("/api/health")).body.data.demoLimits.paypalWritesToday).toBe(0);
  });

  it("limits PayPal reads per address and caches list reads for 30 seconds", async () => {
    const { get, post, pp } = await start({ PAYPAL_READ_RATE_LIMIT: "3" });
    const lists = () => pp.calls.filter((c) => c.url.includes("/v2/invoicing/invoices?")).length;
    expect((await get("/api/invoices")).status).toBe(200);
    expect((await get("/api/invoices")).status).toBe(200);
    expect(lists()).toBe(1); // second read came from the cache
    // An executed action clears the cache.
    const p = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    await post(`/api/proposals/${p.id}/approve`);
    expect((await get("/api/invoices")).status).toBe(200);
    expect(lists()).toBe(2);
    const limited = await get("/api/invoices");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("read_rate_limited");
  });

  it("seeds at most once per session per interval and up to the global daily cap", async () => {
    const { post, other } = await start({ SEED_DAILY_CAP: "1" });
    const seed = (await post("/api/demo/seed")).body.data.proposal;
    expect((await post(`/api/proposals/${seed.id}/approve`)).body.data.status).toBe("executed");
    const again = await post("/api/demo/seed");
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe("seed_rate_limited");
    const someoneElse = await other().post("/api/demo/seed");
    expect(someoneElse.body.error.code).toBe("seed_daily_cap");
  });

  it("runs at most EXECUTION_CONCURRENCY approved actions at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const normal = createFakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? { json: { access_token: "t", expires_in: 3600 } } : c.url.endsWith("/generate-next-invoice-number") ? { json: { invoice_number: "1" } } : c.url.endsWith("/send") ? { json: {} } : { status: 201, json: { id: "INV2-X" } })).fetch;
    const slow: FetchLike = async (url, init) => {
      if (url.endsWith("/v2/invoicing/invoices") && init?.method === "POST") await gate;
      return normal(url, init);
    };
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch: slow });
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: client, settings: loadSettings({ ...BUYERS, EXECUTION_CONCURRENCY: "1" }) });
    close = app.close;
    const a = (await app.post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    const b = (await app.post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 2" } })).body.data.proposal;
    const first = app.post(`/api/proposals/${a.id}/approve`);
    await new Promise((r) => setTimeout(r, 50));
    const busy = await app.post(`/api/proposals/${b.id}/approve`);
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe("executor_busy");
    release();
    expect((await first).body.data.status).toBe("executed");
    expect((await app.post(`/api/proposals/${b.id}/approve`)).body.data.status).toBe("executed");
  });

  it("limits the webhook route before any verification call", async () => {
    const { base, pp } = await start({ WEBHOOK_RATE_LIMIT: "2" });
    const headers = {
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
      "paypal-transmission-id": "T-1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-11-01T00:00:00Z",
    };
    const send = (id: string) => fetch(`${base}/webhooks/paypal`, { method: "POST", headers, body: JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED" }) });
    expect((await send("WH-1")).status).toBe(200);
    expect((await send("WH-2")).status).toBe(200);
    const limited = await send("WH-3");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(pp.calls.filter((c) => c.url.endsWith("/verify-webhook-signature"))).toHaveLength(2);
  });

  it("the return page shows a friendly page when the read limit is reached", async () => {
    const ORDER = "5O190127TN364715T";
    const pp = sandbox((c) => {
      if (c.url === `${SANDBOX}/v2/checkout/orders` && c.method === "POST") return { json: { id: ORDER, status: "PAYER_ACTION_REQUIRED", links: [] } };
      if (c.url === `${SANDBOX}/v2/checkout/orders/${ORDER}`) return { json: { id: ORDER, status: "CREATED" } };
      return undefined;
    });
    const { post, get } = await start({ PAYMENT_PATH: "order", PAYPAL_READ_RATE_LIMIT: "1" }, pp);
    const p = (await post("/api/invoices/prepare", { listing: LISTING, buyer: { alias: "Demo buyer 1" } })).body.data.proposal;
    await post(`/api/proposals/${p.id}/approve`);
    expect((await get(`/paypal/return?token=${ORDER}`)).body).toMatch(/not approved yet/);
    const limited = await get(`/paypal/return?token=${ORDER}`);
    expect(limited.headers.get("content-type")).toMatch(/text\/html/);
    expect(limited.body).toMatch(/try again shortly/i);
  });
});
