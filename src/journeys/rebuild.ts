import type { PayPalApi } from "../paypal/offline.js";
import type { PayPalReadCache } from "../paypal/read-cache.js";
import type { Invoice, OrderResponse } from "../paypal/types.js";
import { absorbInvoice, absorbInvoiceTitles, isPaidInvoiceStatus } from "./journeys.js";
import { carrierName } from "./record.js";
import type { Sale, SaleRegistry } from "./sales.js";

// Pass 6: journeys rebuilt from PayPal after a restart (free hosting sleeps after ~15 minutes)
// show what PayPal knows. Per rebuilt invoice sale, at most:
//  - one GET /v2/invoicing/invoices/{id} for the item name and the private memo (Japanese
//    title), when the list entry did not carry them (hosted 2026-11-01: it did not);
//  - for paid invoices without tracking: GET /v2/payments/captures/{payment id} for the
//    Orders v2 order behind the payment, then GET /v2/checkout/orders/{id} for its trackers.
// Bounded: only sales rebuilt from this demo's invoices (sale marker), at most
// REBUILD_READS_PER_REQUEST PayPal reads per journeys read, every read through the shared read
// cache, and a sale that was checked (found nothing, or a read failed) waits REBUILD_RECHECK_MS.
// A failed read leaves the journey as it is.

export const REBUILD_READS_PER_REQUEST = 4;
export const REBUILD_RECHECK_MS = 10 * 60_000;

export interface FoundTracking {
  number: string;
  carrier?: string;
  at?: string;
}

/**
 * The newest tracker of an Orders v2 order that is not CANCELLED, for this capture. PayPal's
 * `tracker` has no tracking number field; its id is "<capture id>-<tracking number>". A
 * `tracking_number` field is used when present. No number → no tracking.
 */
export function trackingOfOrder(order: OrderResponse, captureId: string): FoundTracking | undefined {
  const found: Array<FoundTracking & { sortKey: string }> = [];
  for (const unit of order.purchase_units ?? []) {
    for (const t of unit.shipping?.trackers ?? []) {
      if (!t || t.status === "CANCELLED") continue;
      const fromId = typeof t.id === "string" && t.id.startsWith(`${captureId}-`) ? t.id.slice(captureId.length + 1) : undefined;
      const number = (typeof t.tracking_number === "string" && t.tracking_number.trim()) || fromId?.trim();
      if (!number) continue;
      const carrier = typeof t.carrier === "string" && t.carrier ? carrierName({ carrier: t.carrier, ...(typeof t.carrier_name_other === "string" ? { carrier_name_other: t.carrier_name_other } : {}) }) : undefined;
      const at = t.create_time ?? t.update_time;
      found.push({ number: number.slice(0, 64), ...(carrier ? { carrier } : {}), ...(at ? { at } : {}), sortKey: t.update_time ?? t.create_time ?? "" });
    }
  }
  if (found.length === 0) return undefined;
  const { sortKey: _ignored, ...newest } = found.reduce((a, b) => (b.sortKey >= a.sortKey ? b : a));
  return newest;
}

function paymentIdOf(inv: Invoice | undefined): string | undefined {
  return (inv?.payments?.transactions ?? []).find((t) => t.payment_id)?.payment_id;
}

/** Reads for rebuilt sales still missing titles or tracking (bounded, see above). Never throws. */
export async function completeRebuiltSales(
  deps: { sales: SaleRegistry; reads: PayPalReadCache },
  paypal: PayPalApi,
  /** PayPal's invoice list of this request, by id (status of each invoice). */
  invoices: Map<string, Invoice>,
  now: number = Date.now(),
): Promise<void> {
  let budget = REBUILD_READS_PER_REQUEST;
  const needsTracking = (s: Sale, inv: Invoice | undefined) => !s.tracking && isPaidInvoiceStatus(inv?.status);
  const candidates = deps.sales
    .all()
    .filter((s) => s.rebuilt && s.owner === "" && s.path === "invoice" && s.invoiceId && invoices.has(s.invoiceId))
    .filter((s) => !s.rebuilt!.detailRead || needsTracking(s, invoices.get(s.invoiceId!)))
    .filter((s) => s.rebuilt!.checkedAt === undefined || now - s.rebuilt!.checkedAt >= REBUILD_RECHECK_MS)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const sale of candidates) {
    if (budget <= 0) break;
    const state = sale.rebuilt!;
    const invoiceId = sale.invoiceId!;
    let inv = invoices.get(invoiceId);
    const checked = () => {
      state.checkedAt = now;
    };
    if (!state.detailRead) {
      budget -= 1;
      try {
        const full = await deps.reads.getInvoice(paypal, invoiceId);
        absorbInvoiceTitles(sale, full);
        absorbInvoice(deps.sales, sale, full);
        state.detailRead = true;
        if (!paymentIdOf(inv)) inv = full;
      } catch {
        checked();
        continue;
      }
    }
    if (!needsTracking(sale, inv)) continue;
    const captureId = paymentIdOf(inv) ?? sale.transactionId;
    if (!captureId) {
      checked();
      continue;
    }
    // Capture and order are read together; without budget for both, the next read continues.
    if (budget < 2) break;
    budget -= 2;
    checked();
    try {
      const capture = deps.reads.getCapture(paypal, captureId);
      const orderId = capture ? (await capture).supplementary_data?.related_ids?.order_id : undefined;
      if (!orderId) continue;
      const found = trackingOfOrder(await deps.reads.getOrder(paypal, orderId), captureId);
      if (!found || sale.tracking) continue;
      const at = found.at ?? new Date(now).toISOString();
      sale.tracking = { ...(found.carrier ? { carrier: found.carrier } : {}), number: found.number, at };
      deps.sales.note(sale, `Tracking ${found.number}${found.carrier ? ` (${found.carrier})` : ""} found in PayPal after a restart`, at);
    } catch {
      // A failed read leaves the journey as it is (retried after REBUILD_RECHECK_MS).
    }
  }
}
