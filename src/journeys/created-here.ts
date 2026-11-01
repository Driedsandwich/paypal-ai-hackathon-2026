import { HttpError } from "../http/util.js";
import { carrierFor } from "../paypal/carriers.js";
import type { PayPalClient } from "../paypal/client.js";
import type { PayPalApi } from "../paypal/offline.js";
import type { AddInvoiceTrackingPayload, AddOrderTrackingPayload } from "../proposals/actions.js";
import type { OrderRegistry } from "../proposals/order-registry.js";
import { parseSaleMarker, type SaleRegistry } from "./sales.js";

// Tracking proposals only for invoices and orders this demo created (pass 2, follow-up to
// the F4 return-URL registry). "Created here" means: known to the in-memory registries, or
// carrying this app's sale marker in the PayPal record (invoice `detail.reference`, order
// `purchase_units[0].custom_id`), which survives a restart of the free hosting instance.

export type TrackingTarget = { kind: "invoice"; invoice_id?: string; transaction_id?: string } | { kind: "order"; order_id: string };

export interface TrackingCheck {
  saleId?: string;
  /** Invoice payments: the PayPal transaction the tracker is attached to. */
  transactionId?: string;
  /** Invoice payments: the Orders v2 order behind that payment, when PayPal names it. */
  orderId?: string;
}

/**
 * The Orders v2 order behind a payment (capture), from `supplementary_data.related_ids.order_id`.
 * Undefined when the PayPal stand-in cannot read captures (offline demo, tests) or the read fails.
 */
export async function orderOfCapture(paypal: PayPalApi, captureId: string): Promise<string | undefined> {
  const reader = paypal as PayPalApi & Partial<Pick<PayPalClient, "getCapture">>;
  if (typeof reader.getCapture !== "function") return undefined;
  try {
    return (await reader.getCapture(captureId)).supplementary_data?.related_ids?.order_id || undefined;
  } catch {
    return undefined;
  }
}

export type InvoiceTrackingProposal =
  | { kind: "add_order_tracking"; payload: AddOrderTrackingPayload }
  | { kind: "add_invoice_tracking"; payload: AddInvoiceTrackingPayload };

/**
 * Tracking for an invoice payment. Invoice payments are captures of an Orders v2 order, so when
 * PayPal names the order the tracker goes through Orders v2 `/track` (the same call as payment
 * links). Add Tracking v1 (`trackers-batch`) needs the shipping trackers scope, which the hosted
 * demo's sandbox app does not have (403 NOT_AUTHORIZED, 2026-11-01); it stays as the fallback.
 */
export function invoiceTrackingProposal(check: TrackingCheck, carrier: string, trackingNumber: string, notify: boolean): InvoiceTrackingProposal {
  const transactionId = check.transactionId!;
  if (check.orderId) {
    return {
      kind: "add_order_tracking",
      payload: { orderId: check.orderId, tracker: { capture_id: transactionId, tracking_number: trackingNumber, ...carrierFor(carrier, "orders"), notify_payer: notify } },
    };
  }
  return {
    kind: "add_invoice_tracking",
    payload: { trackers: [{ transaction_id: transactionId, tracking_number: trackingNumber, status: "SHIPPED", ...carrierFor(carrier, "shipping"), notify_buyer: notify }] },
  };
}

function refused(what: string): HttpError {
  return new HttpError(
    403,
    "not_created_by_demo",
    `Tracking can only be added to ${what} created by this demo (the shared sandbox account may hold others). Start the sale here with New item, or pick one of the journeys.`,
  );
}

export async function checkTrackingTarget(deps: { sales: SaleRegistry; orders: OrderRegistry }, paypal: PayPalApi, target: TrackingTarget): Promise<TrackingCheck> {
  if (target.kind === "order") {
    const sale = deps.sales.byOrder(target.order_id);
    if (sale || deps.orders.get(target.order_id)) return sale ? { saleId: sale.id } : {};
    const marker = parseSaleMarker((await paypal.getOrder(target.order_id)).purchase_units?.[0]?.custom_id);
    if (!marker) throw refused("payment links");
    return { saleId: marker.saleId };
  }
  if (target.invoice_id) {
    const sale = deps.sales.byInvoice(target.invoice_id);
    const inv = await paypal.getInvoice(target.invoice_id);
    const marker = parseSaleMarker(inv.detail?.reference);
    if (!sale && !marker) throw refused("invoices");
    const transactionId = (inv.payments?.transactions ?? []).find((t) => t.payment_id)?.payment_id;
    if (!transactionId) throw new HttpError(409, "invoice_not_paid", "This invoice has no PayPal payment yet, so there is no transaction to attach tracking to.");
    const orderId = await orderOfCapture(paypal, transactionId);
    return { saleId: sale?.id ?? marker!.saleId, transactionId, ...(orderId ? { orderId } : {}) };
  }
  if (target.transaction_id) {
    const sale = deps.sales.byTransaction(target.transaction_id);
    if (!sale) throw refused("payments of invoices");
    const orderId = await orderOfCapture(paypal, target.transaction_id);
    return { saleId: sale.id, transactionId: target.transaction_id, ...(orderId ? { orderId } : {}) };
  }
  throw new HttpError(400, "invalid_input", "Give invoice_id (invoice payments) or order_id and capture_id (payment links).");
}
