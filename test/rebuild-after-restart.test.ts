import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildInvoicePayload } from "../src/agent/tasks.js";
import { loadSettings } from "../src/config.js";
import { DemoBuyers } from "../src/demo/buyers.js";
import { saleFromInvoice } from "../src/journeys/journeys.js";
import { REBUILD_READS_PER_REQUEST, trackingOfOrder } from "../src/journeys/rebuild.js";
import { parseTitleMemo, saleMarker, titleMemo } from "../src/journeys/sales.js";
import type { Invoice, OrderResponse } from "../src/paypal/types.js";
import { FAKE_CONFIG, fakeEmail, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

// Pass 6: after a restart of the free hosting instance, journeys are rebuilt from PayPal. The
// fixture's shapes are explained in its "_about" (spec-shaped, not recorded).
const F = JSON.parse(readFileSync(new URL("./fixtures/rebuild-after-restart-20261101.json", import.meta.url), "utf8"));
const INVOICE_ID: string = F.invoice.id;
const CAPTURE_ID: string = F.capture.id;
const ORDER_ID: string = F.capture.supplementary_data.related_ids.order_id;
const recipients = [{ billing_info: { email_address: fakeEmail("b1") } }];
const listEntry = (over: Record<string, unknown> = {}): Invoice => ({ ...structuredClone(F.list_entry), primary_recipients: recipients, ...over });
const fullInvoice = (): Invoice => ({ ...structuredClone(F.invoice), primary_recipients: recipients });

const settings = loadSettings({ DEMO_BUYER_EMAILS: `${fakeEmail("b1")},${fakeEmail("b2")}`, LIST_CACHE_SECONDS: "0" });
const path = (c: RecordedCall) => c.url.replace(SANDBOX, "");
const READ = (c: RecordedCall) => c.method === "GET" && /^\/v2\/(invoicing\/invoices\/|payments\/captures\/|checkout\/orders\/)/.test(path(c));

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(route: (u: string) => { status?: number; json?: unknown } | undefined, options: { offline?: boolean } = {}) {
  const pp = paypalWith((c) => {
    const u = path(c);
    if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [] } };
    return route(u);
  });
  const app = await startApp({ settings: options.offline ? loadSettings({ PAYPAL_OFFLINE_DEMO: "true" }) : settings, paypalConfig: FAKE_CONFIG, paypal: pp.client });
  close = app.close;
  return { app, pp };
}

/** The hosted case: a trimmed list entry, the full invoice, its capture and the order. */
function sandbox(order: unknown | { status: number; json: unknown }, capture: { status?: number; json?: unknown } = { json: F.capture }) {
  return (u: string) => {
    if (u.startsWith("/v2/invoicing/invoices?")) return { json: { items: [listEntry()] } };
    if (u === `/v2/invoicing/invoices/${INVOICE_ID}`) return { json: fullInvoice() };
    if (u === `/v2/payments/captures/${CAPTURE_ID}`) return capture;
    if (u === `/v2/checkout/orders/${ORDER_ID}`) return order as { status?: number; json?: unknown };
    return undefined;
  };
}

describe("Japanese title in the invoice memo", () => {
  it("is written to detail.memo next to the unchanged sale marker", () => {
    const listing = { title: "Kettle", description: "", price: { currency_code: "USD", value: "120.00" }, quantity: 1 };
    const p = buildInvoicePayload(listing, "Demo buyer 1", { note: "Thanks" }, undefined, saleMarker("OK-8789", "US"), "南部鉄器 鉄瓶 0.8L 新品");
    expect(p.invoice.detail.reference).toBe("Okuri OK-8789 US");
    expect(p.invoice.detail.memo).toBe("Okuri item (Japanese title): 南部鉄器 鉄瓶 0.8L 新品");
    expect(p.invoice.detail.note).toBe("Thanks");
    expect(buildInvoicePayload(listing, "Demo buyer 1", { note: "Thanks" }).invoice.detail).not.toHaveProperty("memo");
    expect(parseTitleMemo(p.invoice.detail.memo)).toBe("南部鉄器 鉄瓶 0.8L 新品");
    expect(parseTitleMemo("Paid by bank transfer")).toBeUndefined();
    expect(titleMemo("  ")).toBeUndefined();
  });

  it("gives a rebuilt journey both titles; an older invoice without memo keeps working", () => {
    const buyers = new DemoBuyers([fakeEmail("b1")]);
    const sale = saleFromInvoice(fullInvoice(), buyers)!;
    expect(sale).toMatchObject({ id: "OK-8789", titleEn: "New Japanese Cast Iron Kettle (Tetsubin), 0.8 L", titleJa: "南部鉄器 鉄瓶 0.8L 新品", rebuilt: { detailRead: true } });
    const old = fullInvoice();
    delete old.detail.memo;
    const oldSale = saleFromInvoice(old, buyers)!;
    expect(oldSale.titleEn).toBe("New Japanese Cast Iron Kettle (Tetsubin), 0.8 L");
    expect(oldSale.titleJa).toBeUndefined();
    // A memo without the sale marker is never read.
    const foreign = fullInvoice();
    delete foreign.detail.reference;
    expect(saleFromInvoice(foreign, buyers)).toBeUndefined();
  });
});

describe("invoice proposal from the New item flow", () => {
  it("carries the Japanese title in the memo", async () => {
    const { app } = await start(() => ({ json: {} }), { offline: true });
    const draft = (await app.post("/api/listings/draft", { item: { title_ja: "手作り 抹茶碗", price_jpy: 12000 }, country: "AU" })).body.data;
    const prep = await app.post("/api/invoices/prepare", { sale_id: draft.sale_id, listing: { title: draft.title, price: { currency_code: "USD", value: draft.price.usd } }, buyer: { alias: "Demo buyer 2" } });
    expect(prep.body.data.proposal.payload.invoice.detail).toMatchObject({ reference: `Okuri ${draft.sale_id} AU`, memo: "Okuri item (Japanese title): 手作り 抹茶碗" });
  });
});

describe("trackers of an Orders v2 order", () => {
  it("takes the tracking number from the tracker id and skips cancelled trackers", () => {
    expect(trackingOfOrder(F.order_with_tracker, CAPTURE_ID)).toEqual({ number: "EJ123456789JP", at: "2026-11-01T09:30:00Z" });
    expect(trackingOfOrder(F.order_without_trackers, CAPTURE_ID)).toBeUndefined();
    const cancelled: OrderResponse = structuredClone(F.order_with_tracker);
    (cancelled.purchase_units![0]!.shipping!.trackers![0]!).status = "CANCELLED";
    expect(trackingOfOrder(cancelled, CAPTURE_ID)).toBeUndefined();
    // An id of another capture gives no number.
    expect(trackingOfOrder(F.order_with_tracker, "OTHERCAPTURE")).toBeUndefined();
    // Fields PayPal's spec does not list are used when present.
    const withCarrier: OrderResponse = structuredClone(F.order_with_tracker);
    Object.assign(withCarrier.purchase_units![0]!.shipping!.trackers![0]!, { carrier: "JPN_JAPAN_POST" });
    expect(trackingOfOrder(withCarrier, CAPTURE_ID)).toMatchObject({ number: "EJ123456789JP", carrier: "Japan Post" });
  });
});

describe("journeys rebuilt after a restart", () => {
  it("show both titles and the tracking PayPal holds for the invoice payment", async () => {
    const { app, pp } = await start(sandbox({ json: F.order_with_tracker }));
    const j = (await app.get("/api/journeys")).body.data.journeys[0];
    expect(j).toMatchObject({
      id: "OK-8789",
      title_en: "New Japanese Cast Iron Kettle (Tetsubin), 0.8 L",
      title_ja: "南部鉄器 鉄瓶 0.8L 新品",
      stage: "shipped",
      current_step: 5,
      tracking: { number: "EJ123456789JP", at: "2026-11-01T09:30:00Z" },
    });
    expect(j.tracking.carrier).toBeUndefined();
    expect(j.steps[3]).toMatchObject({ name: "Tracking", state: "done", label: "Tracking EJ123456789JP" });
    expect(j.activity.map((a: { text: string }) => a.text)).toContain("Tracking EJ123456789JP found in PayPal after a restart");
    expect(pp.calls.filter(READ).map(path)).toEqual([`/v2/invoicing/invoices/${INVOICE_ID}`, `/v2/payments/captures/${CAPTURE_ID}`, `/v2/checkout/orders/${ORDER_ID}`]);
    expect(pp.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token"))).toHaveLength(0);
    // Done once: the next page load reads only the lists.
    await app.get("/api/journeys");
    expect(pp.calls.filter(READ)).toHaveLength(3);
  });

  it("leave the tracking step open when the order has no tracker, and do not read again at once", async () => {
    const { app, pp } = await start(sandbox({ json: F.order_without_trackers }));
    const j = (await app.get("/api/journeys")).body.data.journeys[0];
    expect(j).toMatchObject({ title_ja: "南部鉄器 鉄瓶 0.8L 新品", stage: "paid", current_step: 4 });
    expect(j.tracking).toBeUndefined();
    await app.get("/api/journeys");
    expect(pp.calls.filter(READ)).toHaveLength(3);
  });

  it("leave the journey as it is when a read fails", async () => {
    for (const failing of ["capture", "order", "invoice"] as const) {
      const fail = { status: 500, json: { name: "INTERNAL_SERVER_ERROR", debug_id: "f00f00f00f00f" } };
      const base = sandbox(failing === "order" ? fail : { json: F.order_with_tracker }, failing === "capture" ? fail : { json: F.capture });
      const { app, pp } = await start((u) => (failing === "invoice" && u === `/v2/invoicing/invoices/${INVOICE_ID}` ? fail : base(u)));
      const res = await app.get("/api/journeys");
      expect(res.status).toBe(200);
      const j = res.body.data.journeys[0];
      expect(j).toMatchObject({ id: "OK-8789", stage: "paid", current_step: 4 });
      expect(j.tracking).toBeUndefined();
      expect(res.body.data.warnings).toEqual([]);
      if (failing === "invoice") expect(j.title_en).toBe("Invoice 0008");
      else expect(j.title_ja).toBe("南部鉄器 鉄瓶 0.8L 新品");
      const reads = pp.calls.filter(READ).length;
      await app.get("/api/journeys");
      expect(pp.calls.filter(READ).length).toBe(reads); // retried only after the recheck window
      await close?.();
      close = undefined;
    }
  });

  it(`read at most ${REBUILD_READS_PER_REQUEST} PayPal records per page load`, async () => {
    const entries = [1, 2, 3, 4, 5].map((n) => listEntry({ id: `INV2-TEST-${n}`, detail: { ...F.list_entry.detail, invoice_number: `000${n}`, reference: saleMarker(`OK-900${n}`, "US") } }));
    const { app, pp } = await start((u) => {
      if (u.startsWith("/v2/invoicing/invoices?")) return { json: { items: entries } };
      const inv = /^\/v2\/invoicing\/invoices\/(INV2-TEST-\d)$/.exec(u);
      if (inv) return { json: { ...fullInvoice(), id: inv[1], payments: { transactions: [{ payment_id: `CAP${inv[1]!.slice(-1)}` }] } } };
      if (u.startsWith("/v2/payments/captures/")) return { json: { supplementary_data: { related_ids: { order_id: `ORD${u.slice(-1)}` } } } };
      if (u.startsWith("/v2/checkout/orders/")) return { json: F.order_without_trackers };
      return undefined;
    });
    expect((await app.get("/api/journeys")).body.data.journeys).toHaveLength(5);
    expect(pp.calls.filter(READ).length).toBeLessThanOrEqual(REBUILD_READS_PER_REQUEST);
    const first = pp.calls.filter(READ).length;
    await app.get("/api/journeys");
    expect(pp.calls.filter(READ).length - first).toBeLessThanOrEqual(REBUILD_READS_PER_REQUEST);
  });

  it("are not part of the offline demo (no PayPal reads)", async () => {
    const { app, pp } = await start(() => ({ json: {} }), { offline: true });
    const data = (await app.get("/api/journeys")).body.data;
    expect(data.journeys).toHaveLength(6);
    expect(data.journeys.some((j: { activity: Array<{ text: string }> }) => j.activity.some((a) => a.text.includes("after a restart")))).toBe(false);
    expect(pp.calls).toHaveLength(0);
  });
});
