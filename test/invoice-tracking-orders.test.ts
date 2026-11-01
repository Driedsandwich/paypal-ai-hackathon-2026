import { describe, expect, it } from "vitest";
import { checkTrackingTarget, invoiceTrackingProposal, orderOfCapture } from "../src/journeys/created-here.js";
import { SaleRegistry, saleMarker } from "../src/journeys/sales.js";
import { OfflinePayPal } from "../src/paypal/offline.js";
import { OrderRegistry } from "../src/proposals/order-registry.js";
import { paypalWith } from "./helpers/paypal.js";

// Hosted demo, 2026-11-01: Add Tracking v1 (trackers-batch) answered 403 NOT_AUTHORIZED for an
// invoice payment (the sandbox app has no shipping trackers scope), while the invoice payment's
// capture named its Orders v2 order (supplementary_data.related_ids.order_id) and Orders v2
// /track on that order answered 201 with the tracker SHIPPED.
const INVOICE_ID = "INV2-TEST-0000-0000-0001";
const CAPTURE_ID = "3B6192453A677052J";
const ORDER_ID = "2C993603RE5743412";

function paidInvoice() {
  return {
    id: INVOICE_ID,
    status: "PAID",
    detail: { invoice_number: "0008", reference: saleMarker("OK-8789", "US") },
    payments: { transactions: [{ payment_id: CAPTURE_ID }] },
  };
}

function client(capture: { status?: number; json?: unknown } | undefined) {
  return paypalWith((c) => {
    if (c.url.endsWith(`/v2/invoicing/invoices/${INVOICE_ID}`)) return { json: paidInvoice() };
    if (c.url.endsWith(`/v2/payments/captures/${CAPTURE_ID}`)) return capture;
    return undefined;
  });
}

const deps = () => ({ sales: new SaleRegistry(), orders: new OrderRegistry() });

describe("tracking for invoice payments through Orders v2", () => {
  it("finds the Orders v2 order behind an invoice payment", async () => {
    const pp = client({ json: { id: CAPTURE_ID, status: "COMPLETED", invoice_id: INVOICE_ID, supplementary_data: { related_ids: { order_id: ORDER_ID } } } });
    const check = await checkTrackingTarget(deps(), pp.client, { kind: "invoice", invoice_id: INVOICE_ID });
    expect(check).toEqual({ saleId: "OK-8789", transactionId: CAPTURE_ID, orderId: ORDER_ID });
    expect(pp.apiCalls().map((c) => c.url.replace(/^https:\/\/[^/]+/, ""))).toEqual([`/v2/invoicing/invoices/${INVOICE_ID}`, `/v2/payments/captures/${CAPTURE_ID}`]);
  });

  it("proposes Orders v2 tracking on that order, with PayPal's Japan Post carrier code", () => {
    const t = invoiceTrackingProposal({ saleId: "OK-8789", transactionId: CAPTURE_ID, orderId: ORDER_ID }, "Japan Post", "EJ123456789JP", true);
    expect(t).toEqual({
      kind: "add_order_tracking",
      payload: { orderId: ORDER_ID, tracker: { capture_id: CAPTURE_ID, tracking_number: "EJ123456789JP", carrier: "JPN_JAPAN_POST", notify_payer: true } },
    });
  });

  it("falls back to trackers-batch when PayPal names no order", () => {
    const t = invoiceTrackingProposal({ saleId: "OK-8789", transactionId: CAPTURE_ID }, "Japan Post", "EJ123456789JP", false);
    expect(t).toEqual({
      kind: "add_invoice_tracking",
      payload: { trackers: [{ transaction_id: CAPTURE_ID, tracking_number: "EJ123456789JP", status: "SHIPPED", carrier: "JPN_JAPAN_POST", notify_buyer: false }] },
    });
  });

  it("does not fail the tracking check when the capture cannot be read", async () => {
    const pp = client({ status: 404, json: { name: "RESOURCE_NOT_FOUND", debug_id: "0a0a0a0a0a0a0" } });
    const check = await checkTrackingTarget(deps(), pp.client, { kind: "invoice", invoice_id: INVOICE_ID });
    expect(check).toEqual({ saleId: "OK-8789", transactionId: CAPTURE_ID });
  });

  it("returns no order when the capture has no related order or the PayPal stand-in cannot read captures", async () => {
    const pp = client({ json: { id: CAPTURE_ID, status: "COMPLETED" } });
    expect(await orderOfCapture(pp.client, CAPTURE_ID)).toBeUndefined();
    expect(await orderOfCapture(new OfflinePayPal(), CAPTURE_ID)).toBeUndefined();
  });
});
