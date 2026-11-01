import { afterEach, describe, expect, it } from "vitest";
import { ListingForSaleSchema, listingTotals } from "../src/agent/schemas.js";
import { buildInvoicePayload, buildOrderPayload } from "../src/agent/tasks.js";
import { loadSettings } from "../src/config.js";
import { MoneyError } from "../src/money.js";
import { OfflinePayPal } from "../src/paypal/offline.js";
import type { AppOptions } from "../src/server.js";
import { FAKE_CONFIG, fakeEmail, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

// Pass 4, item 3: optional shipping charge on invoices (Invoicing v2 amount.breakdown.shipping).

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});
async function start(options: AppOptions) {
  const app = await startApp(options);
  close = app.close;
  return app;
}

const LISTING = { title: "Handmade Japanese Tea Bowl", description: "Stoneware.", price: { currency_code: "USD", value: "110" }, quantity: 1 };
const SHIP = { currency_code: "USD", value: "18" };
const BUYERS = { DEMO_BUYER_EMAILS: `${fakeEmail("b1")},${fakeEmail("b2")}` };
const CONFIG = { publicBaseUrl: "http://localhost:3000" };

describe("shipping amounts", () => {
  it("totals in minor units, formatted per currency", () => {
    expect(listingTotals({ ...LISTING, shipping: SHIP })).toEqual({ currency_code: "USD", unit: "110.00", item_total: "110.00", shipping: "18.00", total: "128.00" });
    expect(listingTotals({ ...LISTING, price: { currency_code: "USD", value: "0.10" }, quantity: 3, shipping: { currency_code: "USD", value: "0.20" } }).total).toBe("0.50");
    expect(listingTotals({ price: { currency_code: "JPY", value: "12000" }, quantity: 2, shipping: { currency_code: "JPY", value: "2500" } })).toMatchObject({ item_total: "24000", shipping: "2500", total: "26500" });
    expect(listingTotals(LISTING)).toEqual({ currency_code: "USD", unit: "110.00", item_total: "110.00", total: "110.00" });
  });

  it("validates shipping like a price: same currency, pass-2a precision, greater than zero", () => {
    const issues = (shipping: unknown, price = LISTING.price) => {
      const r = ListingForSaleSchema.safeParse({ ...LISTING, price, shipping });
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    };
    expect(issues(SHIP)).toEqual([]);
    expect(issues(undefined)).toEqual([]);
    expect(issues({ currency_code: "EUR", value: "18" }).join(" ")).toMatch(/shipping\.currency_code: shipping must be in the price's currency \(USD\)/);
    expect(issues({ currency_code: "USD", value: "18.505" }).join(" ")).toMatch(/shipping\.value: use an amount with at most 2 decimals/);
    expect(issues({ currency_code: "JPY", value: "100.5" }, { currency_code: "JPY", value: "12000" }).join(" ")).toMatch(/shipping\.value: JPY has no decimals/);
    expect(issues({ currency_code: "USD", value: "0" }).join(" ")).toMatch(/greater than zero/);
    expect(() => listingTotals({ ...LISTING, shipping: { currency_code: "USD", value: "1.234" } })).toThrow(MoneyError);
  });

  it("invoice payload: Invoicing v2 shipping field only when there is shipping", () => {
    const withShip = buildInvoicePayload({ ...LISTING, shipping: SHIP }, "Demo buyer 1", { note: "Thanks" });
    expect(withShip.invoice.amount).toEqual({ breakdown: { shipping: { amount: { currency_code: "USD", value: "18.00" } } } });
    expect(withShip.invoice.items[0]!.unit_amount).toEqual({ currency_code: "USD", value: "110.00" });
    expect(buildInvoicePayload(LISTING, "Demo buyer 1", { note: "Thanks" }).invoice).not.toHaveProperty("amount");
  });

  it("payment-link payload: shipping in the breakdown and in the total", () => {
    const unit = buildOrderPayload({ ...LISTING, shipping: SHIP }, "Demo buyer 1", CONFIG).order.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "USD", value: "128.00", breakdown: { item_total: { currency_code: "USD", value: "110.00" }, shipping: { currency_code: "USD", value: "18.00" } } });
    expect(buildOrderPayload(LISTING, "Demo buyer 1", CONFIG).order.purchase_units[0]!.amount).toEqual({ currency_code: "USD", value: "110.00", breakdown: { item_total: { currency_code: "USD", value: "110.00" } } });
  });
});

describe("shipping over HTTP", () => {
  const WRITE = (c: RecordedCall) => c.method !== "GET" && !c.url.endsWith("/v1/oauth2/token");
  function sandbox() {
    return paypalWith((c) => {
      const u = c.url.replace(SANDBOX, "");
      if (u === "/v2/invoicing/generate-next-invoice-number") return { json: { invoice_number: "0003" } };
      if (u === "/v2/invoicing/invoices" && c.method === "POST") return { status: 201, json: { id: "INV2-NEW", status: "DRAFT" } };
      if (/^\/v2\/invoicing\/invoices\/[^/]+\/send$/.test(u)) return { json: { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-NEW", rel: "payer-view" } };
      return undefined;
    });
  }

  it("the proposal carries the shipping, the journey shows the billed total, PayPal gets the shipping field", async () => {
    const pp = sandbox();
    const { post, get } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings(BUYERS) });
    const prepared = await post("/api/invoices/prepare", { listing: { ...LISTING, shipping: SHIP }, buyer: { alias: "Demo buyer 1" } });
    expect(prepared.status).toBe(200);
    const proposal = prepared.body.data.proposal;
    expect(proposal.payload.invoice.amount).toEqual({ breakdown: { shipping: { amount: { currency_code: "USD", value: "18.00" } } } });
    expect(pp.calls.filter(WRITE)).toHaveLength(0);

    const sale = (await get("/api/journeys")).body.data.journeys.find((j: { id: string }) => j.id === prepared.body.data.sale_id);
    expect(sale.amount).toEqual({ currency_code: "USD", value: "128.00" });
    expect(sale.listing.shipping).toEqual(SHIP);

    expect((await post(`/api/proposals/${proposal.id}/approve`)).body.data.status).toBe("executed");
    const created = pp.calls.find((c) => c.url === `${SANDBOX}/v2/invoicing/invoices` && c.method === "POST")!;
    expect(JSON.parse(created.body!).amount).toEqual({ breakdown: { shipping: { amount: { currency_code: "USD", value: "18.00" } } } });
  });

  it("refuses shipping in another currency or with wrong precision before any proposal exists", async () => {
    const pp = sandbox();
    const { post, get } = await start({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings(BUYERS) });
    const other = await post("/api/invoices/prepare", { listing: { ...LISTING, shipping: { currency_code: "JPY", value: "2000" } }, buyer: { alias: "Demo buyer 1" } });
    expect(other.status).toBe(400);
    expect(other.body.error.issues.join(" ")).toMatch(/listing\.shipping\.currency_code/);
    const jpy = await post("/api/invoices/prepare", { listing: { ...LISTING, price: { currency_code: "JPY", value: "12000" }, shipping: { currency_code: "JPY", value: "1500.5" } }, buyer: { alias: "Demo buyer 1" } });
    expect(jpy.status).toBe(400);
    expect(jpy.body.error.issues.join(" ")).toMatch(/listing\.shipping\.value: JPY has no decimals/);
    expect((await get("/api/proposals")).body.data).toEqual([]);
  });

  it("offline simulator: the invoice total includes the shipping", async () => {
    const paypal = new OfflinePayPal();
    const draft = buildInvoicePayload({ ...LISTING, shipping: SHIP }, "Demo buyer 1", { note: "Thanks" }).invoice;
    const created = await paypal.createDraftInvoice(draft);
    const inv = await paypal.getInvoice(created.id);
    expect(inv.amount).toMatchObject({ currency_code: "USD", value: "128.00", breakdown: { shipping: { amount: { currency_code: "USD", value: "18.00" } } } });
    expect(inv.due_amount).toEqual({ currency_code: "USD", value: "128.00" });
  });
});
