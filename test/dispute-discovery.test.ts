import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { DisputeRegistry, knownDisputes, MAX_DISPUTE_READS_BY_ID, NOT_FOUND_GRACE_MS, parseDisputeId, reduceDispute } from "../src/journeys/disputes.js";
import { SaleRegistry } from "../src/journeys/sales.js";
import { PayPalReadCache } from "../src/paypal/read-cache.js";
import type { Dispute } from "../src/paypal/types.js";
import type { AppOptions } from "../src/server.js";
import { FAKE_CONFIG, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp, visitor } from "./helpers/http.js";
import { paypalError, paypalWith, SANDBOX } from "./helpers/paypal.js";

// The sandbox dispute of 2026-11-01: readable by id, missing from the list for minutes, only a
// "self" link (no seller actions). See the fixture's "_note".
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/sandbox-dispute-20261101.json", import.meta.url), "utf8")) as Dispute;
const CASE_ID = "PP-R-EMU-10195761";
const SELLER_TX = "41110349CV519622S";

/** One of this demo's invoices (marker in detail.reference), paid with the disputed transaction. */
const MARKED_INVOICE = {
  id: "INV2-FIXTURE",
  status: "PAID",
  detail: { currency_code: "USD", invoice_number: "0042", invoice_date: "2026-11-01", reference: "Okuri OK-2042 US" },
  amount: { currency_code: "USD", value: "12.00" },
  items: [{ name: "Furoshiki wrapping cloth", quantity: "1" }],
  payments: { transactions: [{ payment_id: SELLER_TX, payment_date: "2026-11-01" }] },
};

/** A sandbox whose dispute list can lag behind (state.listed) and whose dispute can change. */
function lagging(state: { listed: boolean; dispute: Dispute | undefined; listFails?: boolean; invoices?: unknown[] }) {
  return paypalWith((c: RecordedCall) => {
    const u = c.url.replace(SANDBOX, "");
    if (u.startsWith("/v2/invoicing/invoices?")) return { json: { items: state.invoices ?? [MARKED_INVOICE] } };
    if (u === `/v2/invoicing/invoices/${MARKED_INVOICE.id}`) return { json: MARKED_INVOICE };
    if (u.startsWith("/v1/customer/disputes?")) {
      if (state.listFails) return { status: 500, json: paypalError("INTERNAL_SERVER_ERROR", "dbg-list") };
      // The list item: summary fields only (no transactions, no messages).
      const d = state.dispute;
      return { json: { items: state.listed && d ? [{ dispute_id: d.dispute_id, reason: d.reason, status: d.status, dispute_amount: d.dispute_amount, dispute_life_cycle_stage: d.dispute_life_cycle_stage, links: [{ rel: "self", href: `${SANDBOX}/v1/customer/disputes/${d.dispute_id}` }] }] : [] } };
    }
    const m = /^\/v1\/customer\/disputes\/([^/?]+)$/.exec(u);
    if (m && c.method === "GET") return state.dispute && m[1] === state.dispute.dispute_id ? { json: state.dispute } : { status: 404, json: paypalError("RESOURCE_NOT_FOUND", "dbg-404") };
    return undefined;
  });
}

const LIVE = loadSettings({ LIST_CACHE_SECONDS: "0" });
const disputeReads = (calls: RecordedCall[]) => calls.filter((c) => c.method === "GET" && /\/v1\/customer\/disputes\/[^/?]+$/.test(c.url));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(options: AppOptions) {
  const app = await startApp(options);
  close = app.close;
  return { ...app, other: () => visitor(app.base) };
}

describe("dispute ids", () => {
  it("accepts PayPal case ids (sandbox, live, offline simulator) and nothing else", () => {
    for (const id of [CASE_ID, "PP-D-27803", "PP-000-042-663-135", "PP-D-OFFAB23CD45"]) expect(parseDisputeId(id)).toBe(id);
    expect(parseDisputeId("  pp-r-emu-10195761 \n")).toBe(CASE_ID);
    for (const bad of ["", "PP-", "PP--1", "INV2-ABCD", "PP-D-1/../x", "PP-D-1 OR 1=1", "PP-D-1?x=1", `PP-${"A".repeat(70)}`, 42, undefined]) expect(parseDisputeId(bad)).toBeUndefined();
  });
});

describe("DisputeRegistry", () => {
  it("stores reduced data: no messages or evidence; keeps transaction ids and action links from reads by id", () => {
    const reg = new DisputeRegistry();
    reg.note(CASE_ID, "by_id", FIXTURE, true);
    const stored = reg.get(CASE_ID)!.data!;
    expect(stored).not.toHaveProperty("messages");
    expect(stored).not.toHaveProperty("evidences");
    expect(stored).not.toHaveProperty("_note");
    expect(stored.disputed_transactions).toEqual([{ seller_transaction_id: SELLER_TX, transaction_status: "COMPLETED", gross_amount: { currency_code: "USD", value: "12.00" } }]);
    // A later list item without transactions or action links does not erase them.
    reg.note(CASE_ID, "list", { dispute_id: CASE_ID, status: "UNDER_REVIEW", links: [] });
    const merged = reg.get(CASE_ID)!;
    expect(merged.sources).toEqual(["by_id", "list"]);
    expect(merged.data).toMatchObject({ status: "UNDER_REVIEW", disputed_transactions: [{ seller_transaction_id: SELLER_TX }], links: FIXTURE.links });
    expect(reduceDispute({ dispute_id: "PP-D-1", buyer: { email: "x" } } as unknown as Dispute)).toEqual({ dispute_id: "PP-D-1" });
  });

  it("is bounded and forgets old entries", () => {
    let now = 0;
    const reg = new DisputeRegistry({ max: 3, ttlMs: 1000, now: () => now });
    for (const n of [1, 2, 3, 4]) reg.note(`PP-D-${n}`, "webhook");
    expect(reg.all().map((e) => e.id)).toEqual(["PP-D-4", "PP-D-3", "PP-D-2"]);
    now = 1001;
    expect(reg.size).toBe(3);
    expect(reg.all()).toEqual([]);
  });
});

describe("dispute discovery: list, then registered ids", () => {
  it("shows a case PayPal's list does not return yet once it was read by id, and links it to the journey by seller_transaction_id", async () => {
    const state = { listed: false, dispute: FIXTURE as Dispute | undefined };
    const pp = lagging(state);
    const disputes = new DisputeRegistry();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });

    // The sale is rebuilt from the marked invoice; PayPal's list has no dispute yet.
    let journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey).toMatchObject({ stage: "paid" });
    expect(journey.dispute).toBeUndefined();
    expect((await app.get("/api/disputes")).body.data.disputes).toEqual([]);

    // Read by id: PayPal has it. The detail is linked to the sale, and the id is now known.
    const detail = await app.get(`/api/disputes/${CASE_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ dispute_id: CASE_ID, sale_id: "OK-2042", stage: "INQUIRY" });
    expect(disputes.get(CASE_ID)?.sources).toEqual(["by_id"]);

    const rows = (await app.get("/api/disputes")).body.data.disputes;
    expect(rows).toEqual([expect.objectContaining({ dispute_id: CASE_ID, in_paypal_list: false, sources: ["by_id"], sale_id: "OK-2042", amount: { currency_code: "USD", value: "12.00" } })]);
    expect(rows[0]).not.toHaveProperty("messages");

    journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID, open: true, stage: "INQUIRY", in_paypal_list: false, from_step: 3 });
    expect(journey.activity.map((a: any) => a.text)).toContain("Buyer opened a dispute");
    // Every visitor sees it (the shared sandbox account's case), counted as disputed.
    const other = (await app.other().get("/api/journeys")).body.data;
    expect(other.counts.disputed).toBe(1);

    // PayPal moves the case on: the next read by id shows the new stage.
    state.dispute = { ...FIXTURE, status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK" };
    journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ stage: "CHARGEBACK", status: "UNDER_REVIEW" });

    // The list catches up (its items carry no transaction ids): one row, still linked.
    state.listed = true;
    const before = disputeReads(pp.calls).length;
    const listed = (await app.get("/api/disputes")).body.data.disputes;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ dispute_id: CASE_ID, in_paypal_list: true, sources: ["by_id", "list"], sale_id: "OK-2042" });
    journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID, in_paypal_list: true });
    expect(disputeReads(pp.calls).length).toBe(before); // listed cases are not read one by one
    expect(pp.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token"))).toHaveLength(0);
  });

  it("links a payment-link sale by its capture id", async () => {
    const pp = lagging({ listed: false, dispute: FIXTURE, invoices: [] });
    const sales = new SaleRegistry({ firstNumber: 3000 });
    const sale = sales.create({ owner: "someone", titleEn: "Indigo tenugui", buyerAlias: "Demo buyer 1", country: "CA", path: "order", amount: { currency_code: "USD", value: "12.00" } });
    sales.attachOrder(sale.id, "5O190127TN364715T");
    sale.captureId = SELLER_TX;
    sale.paidAt = new Date().toISOString();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, sales });
    expect((await app.get(`/api/disputes/${CASE_ID}`)).body.data.sale_id).toBe(sale.id);
    const journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === sale.id);
    expect(journey).toMatchObject({ path: "order", stage: "paid", dispute: { dispute_id: CASE_ID, open: true } });
  });

  it("does not link a dispute about someone else's payment", async () => {
    const pp = lagging({ listed: false, dispute: { ...FIXTURE, disputed_transactions: [{ seller_transaction_id: "9XX00000AA0000000" }] }, invoices: [MARKED_INVOICE] });
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client });
    expect((await app.get(`/api/disputes/${CASE_ID}`)).body.data).not.toHaveProperty("sale_id");
    const data = (await app.get("/api/journeys")).body.data;
    expect(data.journeys.find((j: any) => j.id === "OK-2042").dispute).toBeUndefined();
    expect(data.counts.disputed).toBe(0);
    // It is still listed among the account's disputes.
    expect((await app.get("/api/disputes")).body.data.disputes.map((d: any) => d.dispute_id)).toEqual([CASE_ID]);
  });

  it("keeps showing registered cases when PayPal's list fails, and drops ids PayPal no longer has (after a grace period)", async () => {
    const state = { listed: false, dispute: FIXTURE as Dispute | undefined, listFails: true };
    const pp = lagging(state);
    let now = Date.now();
    const disputes = new DisputeRegistry({ now: () => now });
    disputes.note(CASE_ID, "webhook");
    disputes.note("PP-D-GONE", "webhook");
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });
    const res = (await app.get("/api/disputes")).body.data;
    expect(res.disputes.map((d: any) => d.dispute_id)).toEqual([CASE_ID]);
    expect(res.warnings).toEqual([expect.stringMatching(/dispute list could not be read \(debug_id dbg-list\)/)]);
    // Just announced: PayPal may not serve it yet, so the id is kept for an hour.
    expect(disputes.get("PP-D-GONE")).toBeDefined();
    now += NOT_FOUND_GRACE_MS;
    await app.get("/api/disputes");
    expect(disputes.get("PP-D-GONE")).toBeUndefined();
    const journeys = (await app.get("/api/journeys")).body.data;
    expect(journeys.journeys[0].dispute).toMatchObject({ dispute_id: CASE_ID });
    expect(journeys.warnings).toEqual([expect.stringMatching(/dispute list could not be read/)]);

    // With nothing registered, a failing list is an error as before.
    state.dispute = undefined;
    disputes.remove(CASE_ID);
    expect((await app.get("/api/disputes")).status).toBe(502);
  });

  it("reads at most MAX_DISPUTE_READS_BY_ID unlisted cases per page load; the rest show their last known data", async () => {
    const reads: string[] = [];
    const pp = paypalWith((c) => {
      const u = c.url.replace(SANDBOX, "");
      if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [] } };
      const m = /^\/v1\/customer\/disputes\/([^/?]+)$/.exec(u);
      if (m) {
        reads.push(m[1]!);
        return { json: { dispute_id: m[1], status: "OPEN" } };
      }
      return undefined;
    });
    const disputes = new DisputeRegistry();
    const total = MAX_DISPUTE_READS_BY_ID + 3;
    for (let i = 0; i < total; i++) disputes.note(`PP-D-${100 + i}`, "by_id", { dispute_id: `PP-D-${100 + i}`, status: "OLD" });
    const result = await knownDisputes({ reads: new PayPalReadCache(0), disputes, offline: false }, pp.client);
    expect(reads).toHaveLength(MAX_DISPUTE_READS_BY_ID);
    expect(result.items).toHaveLength(total);
    expect(result.items.filter((v) => v.detailed)).toHaveLength(MAX_DISPUTE_READS_BY_ID);
    expect(result.items.filter((v) => !v.detailed).every((v) => v.dispute.status === "OLD")).toBe(true);
  });

  it("the offline demo keeps its private lists and never fills the shared registry", async () => {
    const disputes = new DisputeRegistry();
    const app = await start({ settings: loadSettings({ PAYPAL_OFFLINE_DEMO: "true" }), disputes });
    const journeys = (await app.get("/api/journeys")).body.data.journeys;
    const id = journeys.find((j: any) => j.dispute).dispute.dispute_id;
    expect((await app.get("/api/disputes")).body.data.disputes.map((d: any) => d.dispute_id)).toEqual([id]);
    expect((await app.get(`/api/disputes/${id}`)).status).toBe(200);
    expect(disputes.size).toBe(0);
    // Another visitor neither lists nor reads the first visitor's simulated case.
    const other = app.other();
    expect((await other.get("/api/disputes")).body.data.disputes.map((d: any) => d.dispute_id)).not.toContain(id);
    expect((await other.get(`/api/disputes/${id}`)).status).toBe(404);
  });
});

describe("dispute discovery: verified webhooks", () => {
  const HEADERS = {
    "Content-Type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-id": "TRANSMISSION-TEST-D",
    "paypal-transmission-sig": "fake-signature",
    "paypal-transmission-time": "2026-11-01T09:00:00Z",
  };
  const event = (id: string, type: string, disputeId: unknown) => ({ id, event_type: type, resource: { dispute_id: disputeId, reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN" } });

  /** The lagging sandbox plus webhook verification (and an optional failing dispute read). */
  function sandbox(verification: "SUCCESS" | "FAILURE", state: { dispute: Dispute; readFails?: boolean }) {
    return paypalWith((c) => {
      const u = c.url.replace(SANDBOX, "");
      if (u === "/v1/notifications/verify-webhook-signature") return { json: { verification_status: verification } };
      if (u.startsWith("/v2/invoicing/invoices?")) return { json: { items: [MARKED_INVOICE] } };
      if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [] } };
      if (u === `/v1/customer/disputes/${state.dispute.dispute_id}`) return state.readFails ? { status: 503, json: paypalError("SERVICE_UNAVAILABLE", "dbg-503") } : { json: state.dispute };
      return undefined;
    });
  }

  it("CUSTOMER.DISPUTE.CREATED registers the case, reads it by id and shows it on its journey", async () => {
    const pp = sandbox("SUCCESS", { dispute: FIXTURE });
    const disputes = new DisputeRegistry();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });
    const body = JSON.stringify(event("WH-DISPUTE-1", "CUSTOMER.DISPUTE.CREATED", CASE_ID));
    expect((await app.post("/webhooks/paypal", body, HEADERS)).status).toBe(200);
    await disputes.idle();
    // Verified first, then read by id.
    const paths = pp.apiCalls().map((c) => c.url.replace(SANDBOX, ""));
    expect(paths.slice(0, 2)).toEqual(["/v1/notifications/verify-webhook-signature", `/v1/customer/disputes/${CASE_ID}`]);
    expect(disputes.get(CASE_ID)).toMatchObject({ sources: ["webhook"], data: { dispute_id: CASE_ID, disputed_transactions: [{ seller_transaction_id: SELLER_TX }] } });

    // The journey (rebuilt from the invoice marker, as after a restart) shows the case.
    const journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID, open: true, in_paypal_list: false });
    const rows = (await app.get("/api/disputes")).body.data.disputes;
    expect(rows).toEqual([expect.objectContaining({ dispute_id: CASE_ID, in_paypal_list: false, sources: ["webhook", "by_id"], sale_id: "OK-2042" })]);
    expect((await app.get("/api/events")).body.data).toEqual([expect.objectContaining({ id: "WH-DISPUTE-1", category: "dispute", resourceId: CASE_ID })]);

    // A redelivery is not verified or read again; an UPDATED event reads the case again.
    const reads = () => disputeReads(pp.calls).length;
    const before = reads();
    expect((await app.post("/webhooks/paypal", body, HEADERS)).status).toBe(200);
    await disputes.idle();
    expect(reads()).toBe(before);
    expect((await app.post("/webhooks/paypal", JSON.stringify(event("WH-DISPUTE-2", "CUSTOMER.DISPUTE.UPDATED", CASE_ID)), HEADERS)).status).toBe(200);
    await disputes.idle();
    expect(reads()).toBe(before + 1);
  });

  it("registers nothing for unverified events or events without a valid case id", async () => {
    const pp = sandbox("FAILURE", { dispute: FIXTURE });
    const disputes = new DisputeRegistry();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });
    expect((await app.post("/webhooks/paypal", JSON.stringify(event("WH-FORGED", "CUSTOMER.DISPUTE.CREATED", CASE_ID)), HEADERS)).status).toBe(400);
    await disputes.idle();
    expect(disputes.size).toBe(0);
    expect(disputeReads(pp.calls)).toHaveLength(0);

    const ok = sandbox("SUCCESS", { dispute: FIXTURE });
    const disputes2 = new DisputeRegistry();
    await close?.();
    const app2 = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: ok.client, disputes: disputes2 });
    for (const [i, bad] of ["../../v1/oauth2/token", "INV2-ABCD", 42].entries()) {
      expect((await app2.post("/webhooks/paypal", JSON.stringify(event(`WH-BAD-${i}`, "CUSTOMER.DISPUTE.CREATED", bad)), HEADERS)).status).toBe(200);
    }
    // Other event types never register disputes either.
    expect((await app2.post("/webhooks/paypal", JSON.stringify({ id: "WH-PAID", event_type: "INVOICING.INVOICE.PAID", resource: { dispute_id: CASE_ID } }), HEADERS)).status).toBe(200);
    await disputes2.idle();
    expect(disputes2.size).toBe(0);
    expect(disputeReads(ok.calls)).toHaveLength(0);
  });

  it("keeps the id when the read after the webhook fails, and reads it on the next page load", async () => {
    const state = { dispute: FIXTURE, readFails: true };
    const pp = sandbox("SUCCESS", state);
    const logs: string[] = [];
    const disputes = new DisputeRegistry();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes, log: (m) => logs.push(m) });
    expect((await app.post("/webhooks/paypal", JSON.stringify(event("WH-DISPUTE-3", "CUSTOMER.DISPUTE.CREATED", CASE_ID)), HEADERS)).status).toBe(200);
    await disputes.idle();
    expect(disputes.get(CASE_ID)).toMatchObject({ sources: ["webhook"] });
    expect(disputes.get(CASE_ID)?.data).toBeUndefined();
    expect(logs.join("\n")).toMatch(/read after webhook failed \(503, debug_id dbg-503\)/);

    state.readFails = false;
    const journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID });
  });
});

describe("dispute discovery: Open a case by ID", () => {
  it("validates the id, reads the case from PayPal, registers it and links it to the journey", async () => {
    const pp = lagging({ listed: false, dispute: FIXTURE });
    const disputes = new DisputeRegistry();
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });
    await app.get("/api/journeys");

    // Not a case id: refused before any PayPal call.
    const reads = () => disputeReads(pp.calls).length;
    for (const bad of ["", "INV2-FIXTURE", "PP-R-EMU-1/../../x", "PP-R-EMU-10195761; DROP"]) {
      const r = await app.post("/api/disputes/open", { dispute_id: bad });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("invalid_dispute_id");
    }
    expect((await app.post("/api/disputes/open", {})).status).toBe(400);
    expect(reads()).toBe(0);

    // Unknown at PayPal: 404, nothing registered.
    const unknown = await app.post("/api/disputes/open", { dispute_id: "PP-D-99999" });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ code: "dispute_not_found", paypal: { debugId: "dbg-404" } });
    expect(disputes.size).toBe(0);

    // The sandbox case, pasted with spaces and in lower case.
    const opened = await app.post("/api/disputes/open", { dispute_id: `  ${CASE_ID.toLowerCase()} ` });
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({ dispute_id: CASE_ID, sale_id: "OK-2042", sources: ["by_id"], stage: "INQUIRY", amount: { currency_code: "USD", value: "12.00" } });
    expect(opened.body.data.messages[0].content).toMatch(/has not arrived yet/);
    expect(pp.calls.at(-1)!.url).toBe(`${SANDBOX}/v1/customer/disputes/${CASE_ID}`);

    // Now every visitor finds it in the list and on the journey, although PayPal's list is still empty.
    const other = app.other();
    const rows = (await other.get("/api/disputes")).body.data.disputes;
    expect(rows).toEqual([expect.objectContaining({ dispute_id: CASE_ID, in_paypal_list: false, sale_id: "OK-2042" })]);
    const journey = (await other.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID, open: true });
  });

  it("is limited per session and per address", async () => {
    const pp = lagging({ listed: false, dispute: FIXTURE });
    const app = await start({ settings: loadSettings({ LIST_CACHE_SECONDS: "0", TRUST_PROXY_HOPS: "1" }), paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const from = (ip: string) => ({ "Content-Type": "application/json", "X-Forwarded-For": ip });
    const open = (v: typeof app | ReturnType<typeof app.other>, ip: string) => v.post("/api/disputes/open", { dispute_id: CASE_ID }, from(ip));
    for (let i = 0; i < 10; i++) expect((await open(app, "203.0.113.1")).status).toBe(200);
    const limited = await open(app, "203.0.113.1");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("dispute_lookup_rate_limited");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // Same browser from another address: still limited (per session).
    expect((await open(app, "203.0.113.2")).status).toBe(429);
    // Another browser from the first address: limited (per address); from elsewhere: fine.
    const other = app.other();
    expect((await open(other, "203.0.113.1")).status).toBe(429);
    expect((await open(other, "203.0.113.3")).status).toBe(200);
    expect(disputeReads(pp.calls)).toHaveLength(11);
  });

  it("answers 503 without PayPal and works on the visitor's own simulator in the offline demo", async () => {
    const none = await start({ settings: loadSettings({}) });
    expect((await none.post("/api/disputes/open", { dispute_id: CASE_ID })).status).toBe(503);
    await close?.();
    const disputes = new DisputeRegistry();
    const app = await start({ settings: loadSettings({ PAYPAL_OFFLINE_DEMO: "true" }), disputes });
    const id = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.dispute).dispute.dispute_id;
    const opened = await app.post("/api/disputes/open", { dispute_id: id });
    expect(opened.status).toBe(200);
    expect(opened.body.data.sale_id).toMatch(/^OK-/);
    expect(disputes.size).toBe(0);
    expect((await app.other().post("/api/disputes/open", { dispute_id: id })).status).toBe(404);
  });
});

describe("no seller action at PayPal (links hold only 'self')", () => {
  it("states it clearly; the evidence pack and reply draft stay available read-only; no proposals", async () => {
    const pp = lagging({ listed: false, dispute: FIXTURE });
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client });
    await app.get("/api/journeys");
    const opened = (await app.post("/api/disputes/open", { dispute_id: CASE_ID })).body.data;
    expect(opened).toMatchObject({ seller_action_available: false, notice: "PayPal is reviewing this case. No seller action is available right now." });
    expect(Object.values(opened.allowed_actions).every((v: any) => v.allowed === false)).toBe(true);
    expect((await app.get(`/api/disputes/${CASE_ID}`)).body.data).toMatchObject({ seller_action_available: false, notice: expect.stringMatching(/^PayPal is reviewing this case/) });

    // The journey branch says so too (the case was just read by id).
    const journey = (await app.get("/api/journeys")).body.data.journeys.find((j: any) => j.id === "OK-2042");
    expect(journey.dispute).toMatchObject({ dispute_id: CASE_ID, seller_action_available: false, notice: expect.stringMatching(/No seller action/) });

    // Evidence pack: summary, English reply draft and evidence notes, but nothing to approve.
    const pack = await app.post(`/api/disputes/${CASE_ID}/evidence-pack`, { invoice_id: "INV2-FIXTURE", tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP" } });
    expect(pack.status).toBe(200);
    expect(pack.body.data).toMatchObject({ proposals: {}, seller_action_available: false, notice: expect.stringMatching(/PayPal is reviewing/) });
    expect(pack.body.data.pack.reply_draft).toMatch(/EJ123456789JP/);
    expect(pack.body.data.pack.evidence_notes).toBeTruthy();
    expect(pack.body.data.pack.recommended_action).toBe("wait_for_paypal");
    expect(pack.body.data.allowed_actions.send_message.reason).toMatch(/does not offer sending a message/);
    const accept = await app.post(`/api/disputes/${CASE_ID}/accept-claim`, { note: "Refund" });
    expect(accept.status).toBe(409);
    expect((await app.get("/api/proposals")).body.data).toEqual([]);
    expect(pp.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token"))).toHaveLength(0);
  });

  it("other no-action states get their own sentence; offered actions get none", async () => {
    const { sellerActionState } = await import("../src/paypal/dispute-actions.js");
    expect(sellerActionState({ ...FIXTURE, status: "RESOLVED" })).toEqual({ seller_action_available: false, notice: "This case is closed. No seller action is available." });
    expect(sellerActionState({ ...FIXTURE, status: "WAITING_FOR_BUYER_RESPONSE" }).notice).toMatch(/waiting for the buyer/);
    expect(sellerActionState({ ...FIXTURE, status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK" }).notice).toBe("PayPal is reviewing this case. No seller action is available right now.");
    const withEvidence = { ...FIXTURE, links: [...FIXTURE.links!, { rel: "provide_evidence", method: "POST", href: `${SANDBOX}/v1/customer/disputes/${CASE_ID}/provide-evidence` }] };
    expect(sellerActionState(withEvidence)).toEqual({ seller_action_available: true });
  });
});
