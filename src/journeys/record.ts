import type {
  AddInvoiceTrackingPayload,
  AddOrderTrackingPayload,
  CreateAndSendInvoicePayload,
  CreatePaymentLinkPayload,
  SeedDemoDataPayload,
} from "../proposals/actions.js";
import type { Proposal } from "../proposals/store.js";
import { parseSaleMarker, type Sale, type SaleRegistry } from "./sales.js";

/** Carrier as the seller typed it, from the stored tracker (code or OTHER + free text). */
function carrierName(t: { carrier?: string; carrier_name_other?: string }): string {
  if (t.carrier === "OTHER") return t.carrier_name_other ?? "Other carrier";
  const names: Record<string, string> = { JPN_JAPAN_POST: "Japan Post", YAMATO: "Yamato", JP_KURO_NEKO_YAMATO_UNYUU: "Yamato", SAGAWA: "Sagawa", JPN_SAGAWA: "Sagawa", DHL: "DHL", DHL_JP: "DHL Japan", FEDEX: "FedEx", UPS: "UPS", USPS: "USPS" };
  return names[t.carrier ?? ""] ?? t.carrier ?? "Carrier";
}

function saleOf(registry: SaleRegistry, p: Proposal): Sale | undefined {
  return p.saleId ? registry.get(p.saleId) : undefined;
}

/**
 * After an approved action ran, records what happened on the sale (journey). Called by the
 * approve route; never changes what was sent.
 */
export function recordExecution(registry: SaleRegistry, p: Proposal): void {
  const at = p.decidedAt ?? new Date().toISOString();
  if (p.status !== "executed") {
    const sale = saleOf(registry, p);
    if (p.status === "failed" || p.status === "unknown" || p.status === "obsolete") registry.note(sale, `${p.title}: ${p.status === "unknown" ? "outcome unknown, needs checking" : p.status}`, at);
    return;
  }
  const result = (p.result ?? {}) as Record<string, unknown>;
  switch (p.kind) {
    case "create_and_send_invoice": {
      const payload = p.payload as CreateAndSendInvoicePayload;
      const saleId = p.saleId ?? parseSaleMarker(payload.invoice.detail.reference)?.saleId;
      const sale = saleId ? registry.attachInvoice(saleId, String(result.invoiceId), result.invoiceNumber ? String(result.invoiceNumber) : undefined) : undefined;
      registry.note(sale, `Invoice ${result.invoiceNumber ?? ""} sent via PayPal`.replace("  ", " "), at);
      return;
    }
    case "create_payment_link": {
      const payload = p.payload as CreatePaymentLinkPayload;
      const saleId = p.saleId ?? parseSaleMarker(payload.order.purchase_units[0]?.custom_id)?.saleId;
      const sale = saleId ? registry.attachOrder(saleId, String(result.orderId)) : undefined;
      registry.note(sale, "PayPal payment link created", at);
      return;
    }
    case "capture_order": {
      const sale = registry.byOrder(String(result.orderId ?? "")) ?? saleOf(registry, p);
      if (sale && result.captureId) {
        sale.captureId = String(result.captureId);
        sale.paidAt = at;
      }
      registry.note(sale, "Payment captured through PayPal", at);
      return;
    }
    case "send_invoice_reminder":
      registry.note(saleOf(registry, p), "PayPal's standard reminder sent", at);
      return;
    case "add_invoice_tracking":
    case "add_order_tracking": {
      const sale = saleOf(registry, p);
      const t = p.kind === "add_invoice_tracking" ? (p.payload as AddInvoiceTrackingPayload).trackers[0] : (p.payload as AddOrderTrackingPayload).tracker;
      if (sale && t) {
        sale.tracking = { carrier: carrierName(t), number: t.tracking_number ?? "", at };
        registry.note(sale, `Tracking ${sale.tracking.number} (${sale.tracking.carrier}) registered with PayPal`, at);
      }
      return;
    }
    case "provide_dispute_evidence":
      registry.note(saleOf(registry, p), "Evidence sent to PayPal", at);
      return;
    case "send_dispute_message":
      registry.note(saleOf(registry, p), "Reply sent to the buyer in the dispute", at);
      return;
    case "accept_dispute_claim":
      registry.note(saleOf(registry, p), "Claim accepted (buyer refunded)", at);
      return;
    case "seed_demo_data": {
      const payload = p.payload as SeedDemoDataPayload;
      const created = (result.created ?? []) as Array<Record<string, unknown>>;
      const markers = [...(payload.invoices ?? []).map((i) => i.invoice.detail.reference), ...(payload.orders ?? []).map((o) => o.order.purchase_units[0]?.custom_id)];
      created.forEach((c, i) => {
        const saleId = parseSaleMarker(markers[i])?.saleId;
        if (!saleId) return;
        const sale = c.invoiceId ? registry.attachInvoice(saleId, String(c.invoiceId), c.invoiceNumber ? String(c.invoiceNumber) : undefined) : registry.attachOrder(saleId, String(c.orderId));
        registry.note(sale, c.invoiceId ? `Invoice ${c.invoiceNumber ?? ""} sent via PayPal (seed)` : "PayPal payment link created (seed)", at);
      });
      return;
    }
  }
}
