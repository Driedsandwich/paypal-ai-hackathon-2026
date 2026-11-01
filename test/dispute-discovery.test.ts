import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { DisputeRegistry, knownDisputes, MAX_DISPUTE_READS_BY_ID, parseDisputeId, reduceDispute } from "../src/journeys/disputes.js";
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

  it("keeps showing registered cases when PayPal's list fails, and drops ids PayPal no longer has", async () => {
    const state = { listed: false, dispute: FIXTURE as Dispute | undefined, listFails: true };
    const pp = lagging(state);
    const disputes = new DisputeRegistry();
    disputes.note(CASE_ID, "webhook");
    disputes.note("PP-D-GONE", "webhook");
    const app = await start({ settings: LIVE, paypalConfig: FAKE_CONFIG, paypal: pp.client, disputes });
    const res = (await app.get("/api/disputes")).body.data;
    expect(res.disputes.map((d: any) => d.dispute_id)).toEqual([CASE_ID]);
    expect(res.warnings).toEqual([expect.stringMatching(/dispute list could not be read \(debug_id dbg-list\)/)]);
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
