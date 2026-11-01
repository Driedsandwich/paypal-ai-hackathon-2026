import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import type { AppOptions } from "../src/server.js";
import { FakeAiProvider } from "../src/ai/index.js";
import { chat } from "../src/agent/tools.js";
import { DemoBuyers } from "../src/demo/buyers.js";
import { checkTrackingTarget } from "../src/journeys/created-here.js";
import { parseSaleMarker, saleMarker, SaleRegistry } from "../src/journeys/sales.js";
import { OfflinePayPal } from "../src/paypal/offline.js";
import { OrderRegistry } from "../src/proposals/order-registry.js";
import { ProposalStore } from "../src/proposals/store.js";
import { FAKE_CONFIG, fakeEmail, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp, visitor } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start(options: AppOptions = {}) {
  const app = await startApp(options);
  close = app.close;
  return { ...app, other: () => visitor(app.base) };
}

const OFFLINE = loadSettings({ PAYPAL_OFFLINE_DEMO: "true" });
const WRITE = (c: RecordedCall) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token");

describe("sale marker", () => {
  it("round-trips and rejects anything else", () => {
    expect(saleMarker("OK-1042", "US")).toBe("Okuri OK-1042 US");
    expect(parseSaleMarker("Okuri OK-1042 US")).toEqual({ saleId: "OK-1042", country: "US" });
    expect(parseSaleMarker("Okuri OK-1042 usa")).toBeUndefined();
    expect(parseSaleMarker("PO 1234")).toBeUndefined();
    expect(parseSaleMarker(undefined)).toBeUndefined();
  });
});

describe("offline demo (PAYPAL_OFFLINE_DEMO=true)", () => {
  it("gives every visitor a private seeded world and runs a sale end to end without PayPal", async () => {
    const pp = paypalWith(() => ({ json: {} }));
    const app = await start({ settings: OFFLINE, paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const health = (await app.get("/api/health")).body.data;
    expect(health.paypal).toMatchObject({ configured: true, offline: true, env: "sandbox" });
    expect(health.banner.join(" ")).toMatch(/simulated in memory/);
    expect(health.demo.buyers.map((b: { alias: string }) => b.alias)).toEqual(["Demo buyer 1", "Demo buyer 2", "Demo buyer 3"]);

    const first = (await app.get("/api/journeys")).body.data;
    expect(first.journeys).toHaveLength(6);
    expect(first.counts).toEqual({ draft: 2, invoiced: 1, paid: 1, shipped: 2, disputed: 1 });
    const vase = first.journeys.find((j: any) => j.title_ja === "手作りの花器");
    expect(vase).toMatchObject({ current_step: 2, stage: "draft", country: "US", amount: { currency_code: "USD", value: "128.00" } });
    expect(vase.callout.kind).toBe("proposal");
    expect(vase.callout.proposal.kind).toBe("create_and_send_invoice");
    expect(vase.callout.proposal.payload.invoice.detail.reference).toBe(`Okuri ${vase.id} US`);
    const disputed = first.journeys.find((j: any) => j.dispute);
    expect(disputed.dispute).toMatchObject({ open: true, from_step: 4, stage: "INQUIRY" });
    expect(first.pending_count).toBe(3);

    // Approve the invoice: it runs in the simulator, the journey moves to "Paid / waiting".
    const approved = (await app.post(`/api/proposals/${vase.callout.proposal.id}/approve`)).body.data;
    expect(approved.status).toBe("executed");
    let j = (await app.get("/api/journeys")).body.data.journeys.find((x: any) => x.id === vase.id);
    expect(j).toMatchObject({ current_step: 3, stage: "invoiced" });
    expect(j.callout.actions).toEqual(["remind", "simulate_payment"]);

    // The buyer pays (simulated), the seller adds tracking (approved), a dispute opens.
    expect((await app.post("/api/offline/simulate", { sale_id: vase.id, action: "payment" })).status).toBe(200);
    j = (await app.get("/api/journeys")).body.data.journeys.find((x: any) => x.id === vase.id);
    expect(j).toMatchObject({ current_step: 4, stage: "paid", can_simulate_dispute: true });
    const track = await app.post("/api/tracking", { kind: "invoice", invoice_id: j.invoice_id, carrier: "Japan Post", tracking_number: "EJ123456789JP" });
    expect(track.status).toBe(201);
    expect(track.body.data.proposal.sale_id).toBe(vase.id);
    expect((await app.post(`/api/proposals/${track.body.data.proposal.id}/approve`)).body.data.status).toBe("executed");
    expect((await app.post("/api/offline/simulate", { sale_id: vase.id, action: "dispute" })).status).toBe(200);
    j = (await app.get("/api/journeys")).body.data.journeys.find((x: any) => x.id === vase.id);
    expect(j).toMatchObject({ current_step: 5, stage: "shipped", tracking: { carrier: "Japan Post", number: "EJ123456789JP" } });
    expect(j.dispute).toMatchObject({ open: true, from_step: 4 });
    expect(j.activity.map((a: any) => a.text)).toEqual(expect.arrayContaining(["Buyer paid the invoice through PayPal (simulated)", "Tracking EJ123456789JP (Japan Post) registered with PayPal", "Buyer opened a dispute"]));

    // The evidence pack works on the simulated dispute and is tied to the sale.
    const pack = await app.post(`/api/disputes/${j.dispute.dispute_id}/evidence-pack`, { invoice_id: j.invoice_id, tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP" } });
    expect(pack.status).toBe(200);
    expect(pack.body.data.proposals.send_message.sale_id).toBe(vase.id);

    // Nothing reached the (configured but unused) PayPal client.
    expect(pp.calls).toHaveLength(0);

    // A second visitor has their own world and cannot touch the first one's sale.
    const other = app.other();
    const theirs = (await other.get("/api/journeys")).body.data.journeys;
    expect(theirs).toHaveLength(6);
    expect(theirs.map((x: any) => x.id)).not.toContain(vase.id);
    expect((await other.post("/api/offline/simulate", { sale_id: vase.id, action: "delivery" })).status).toBe(404);
  });

  it("new item → draft journey → invoice proposal on the same journey", async () => {
    const app = await start({ settings: OFFLINE });
    const draft = (await app.post("/api/listings/draft", { item: { title_ja: "手作り 抹茶碗", price_jpy: 12000 }, country: "AU" })).body.data;
    expect(draft.sale_id).toMatch(/^OK-\d+$/);
    let j = (await app.get("/api/journeys")).body.data.journeys.find((x: any) => x.id === draft.sale_id);
    expect(j).toMatchObject({ current_step: 2, country: "AU", callout: { kind: "action", actions: ["prepare_invoice"] } });
    const prep = await app.post("/api/invoices/prepare", { sale_id: draft.sale_id, listing: { title: draft.title, price: { currency_code: "USD", value: draft.price.usd } }, buyer: { alias: "Demo buyer 2" } });
    expect(prep.status).toBe(200);
    expect(prep.body.data.sale_id).toBe(draft.sale_id);
    j = (await app.get("/api/journeys")).body.data.journeys.find((x: any) => x.id === draft.sale_id);
    expect(j.callout.proposal.id).toBe(prep.body.data.proposal.id);
    expect(j.buyer).toBe("Demo buyer 2");
  });

  it("simulate routes do not exist outside the offline demo", async () => {
    const app = await start({ settings: loadSettings({}) });
    expect((await app.post("/api/offline/simulate", { sale_id: "OK-1", action: "payment" })).status).toBe(404);
    const journeys = (await app.get("/api/journeys")).body.data;
    expect(journeys.journeys).toEqual([]);
  });
});

/** A fake sandbox: one invoice made by this app (marker), one made elsewhere, one order each. */
function sandbox() {
  return paypalWith((c) => {
    const u = c.url.replace(SANDBOX, "");
    const mine = { id: "INV2-MINE", status: "PAID", detail: { currency_code: "USD", invoice_number: "0007", invoice_date: "2026-10-20", reference: "Okuri OK-1500 GB" }, amount: { currency_code: "USD", value: "40.00" }, items: [{ name: "Kokeshi doll", quantity: "1" }], primary_recipients: [{ billing_info: { email_address: fakeEmail("b1") } }], payments: { transactions: [{ payment_id: "TX-MINE", payment_date: "2026-10-21" }] } };
    const foreign = { id: "INV2-OTHER", status: "PAID", detail: { currency_code: "USD", invoice_number: "9999" }, amount: { currency_code: "USD", value: "500.00" }, payments: { transactions: [{ payment_id: "TX-OTHER" }] } };
    if (u.startsWith("/v2/invoicing/invoices?")) return { json: { items: [mine, foreign] } };
    if (u === "/v2/invoicing/invoices/INV2-MINE") return { json: mine };
    if (u === "/v2/invoicing/invoices/INV2-OTHER") return { json: foreign };
    if (u === "/v2/checkout/orders/O-OTHER") return { json: { id: "O-OTHER", status: "COMPLETED", purchase_units: [{}] } };
    if (u === "/v2/checkout/orders/O-MINE") return { json: { id: "O-MINE", status: "COMPLETED", purchase_units: [{ custom_id: "Okuri OK-1501 US" }] } };
    if (u.startsWith("/v1/customer/disputes?")) return { json: { items: [{ dispute_id: "PP-D-9", status: "WAITING_FOR_SELLER_RESPONSE", disputed_transactions: [{ seller_transaction_id: "TX-MINE" }] }] } };
    return { json: {} };
  });
}

describe("tracking only for sales created by this demo", () => {
  const settings = loadSettings({ DEMO_BUYER_EMAILS: `${fakeEmail("b1")},${fakeEmail("b2")}` });

  it("accepts marked invoices and orders, refuses others and bare transaction ids", async () => {
    const pp = sandbox();
    const app = await start({ settings, paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const mine = await app.post("/api/tracking", { kind: "invoice", invoice_id: "INV2-MINE", carrier: "Japan Post", tracking_number: "EJ1JP" });
    expect(mine.status).toBe(201);
    expect(mine.body.data.proposal).toMatchObject({ sale_id: "OK-1500", payload: { trackers: [{ transaction_id: "TX-MINE" }] } });
    const order = await app.post("/api/tracking", { kind: "order", order_id: "O-MINE", capture_id: "CAP-1", carrier: "Yamato", tracking_number: "1234" });
    expect(order.status).toBe(201);

    for (const body of [
      { kind: "invoice", invoice_id: "INV2-OTHER", carrier: "Japan Post", tracking_number: "EJ2JP" },
      { kind: "invoice", transaction_id: "TX-OTHER", carrier: "Japan Post", tracking_number: "EJ3JP" },
      { kind: "order", order_id: "O-OTHER", capture_id: "CAP-2", carrier: "Yamato", tracking_number: "5678" },
    ]) {
      const r = await app.post("/api/tracking", body);
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe("not_created_by_demo");
    }
    expect(pp.calls.filter(WRITE)).toHaveLength(0);
  });

  it("rebuilds journeys from marked invoices after a restart and links their disputes", async () => {
    const pp = sandbox();
    const app = await start({ settings, paypalConfig: FAKE_CONFIG, paypal: pp.client });
    const data = (await app.get("/api/journeys")).body.data;
    expect(data.journeys).toHaveLength(1);
    expect(data.journeys[0]).toMatchObject({ id: "OK-1500", country: "GB", buyer: "Demo buyer 1", stage: "paid", current_step: 4, dispute: { dispute_id: "PP-D-9", from_step: 3 } });
    // Visible to every visitor: PayPal holds it on the shared sandbox account.
    expect((await app.other().get("/api/journeys")).body.data.journeys).toHaveLength(1);
  });

  it("chat tool refuses tracking for invoices made elsewhere", async () => {
    const pp = sandbox();
    const sales = new SaleRegistry();
    const proposals = new ProposalStore(async () => {
      throw new Error("must not run");
    });
    const ai = new FakeAiProvider([
      {
        text: "ok",
        toolCalls: [
          { name: "create_shipment_tracking", input: { carrier: "Japan Post", tracking_number: "EJ9JP", invoice_id: "INV2-OTHER" } },
          { name: "create_shipment_tracking", input: { carrier: "Japan Post", tracking_number: "EJ8JP", invoice_id: "INV2-MINE" } },
        ],
        after: (calls) => JSON.stringify(calls.map((c) => c.output)),
      },
    ]);
    const deps = { sales, orders: new OrderRegistry() };
    const res = await chat(
      ai,
      {
        paypal: pp.client,
        proposals,
        agentConfig: { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "http://localhost:3000" },
        paymentPath: "invoice",
        sessionId: "s1",
        buyers: new DemoBuyers([fakeEmail("b1")]),
        trackable: (t) => checkTrackingTarget(deps, pp.client, t),
      },
      [{ role: "user", content: "add tracking" }],
      500,
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ kind: "add_invoice_tracking", saleId: "OK-1500" });
    expect(res.reply).toMatch(/created by this demo/);
  });
});

describe("offline PayPal simulator", () => {
  it("follows the invoice, payment, tracking and dispute rules the app relies on", async () => {
    const sim = new OfflinePayPal();
    const n = await sim.generateNextInvoiceNumber();
    const { id } = await sim.createDraftInvoice({ detail: { currency_code: "USD", invoice_number: n }, items: [{ name: "Bowl", quantity: "2", unit_amount: { currency_code: "USD", value: "40.00" } }] });
    expect((await sim.getInvoice(id)).amount).toEqual({ currency_code: "USD", value: "80.00" });
    await expect(sim.addTrackersBatch([{ transaction_id: "nope", status: "SHIPPED" }])).rejects.toMatchObject({ status: 422 });
    expect(() => sim.simulateInvoicePayment(id)).toThrow(/DRAFT/);
    await sim.sendInvoice(id);
    await sim.remindInvoice(id);
    const tx = sim.simulateInvoicePayment(id);
    await expect(sim.remindInvoice(id)).rejects.toMatchObject({ status: 422 });
    expect((await sim.addTrackersBatch([{ transaction_id: tx, status: "SHIPPED", tracking_number: "1" }])).tracker_identifiers).toHaveLength(1);
    const d = sim.simulateDispute(id);
    const detail = await sim.getDispute(d.dispute_id);
    expect(detail.links?.map((l) => l.rel)).toEqual(["self", "send_message", "provide_evidence", "accept_claim"]);
    await sim.sendDisputeMessage(d.dispute_id, "We shipped it.");
    expect((await sim.getDispute(d.dispute_id)).links?.map((l) => l.rel)).toEqual(["self", "send_message", "accept_claim"]);
    expect(await sim.verifyWebhookSignature()).toBe(false);
  });
});
