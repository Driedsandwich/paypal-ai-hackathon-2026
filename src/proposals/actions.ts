import type { PayPalClient } from "../paypal/client.js";
import type {
  CreateOrderRequest,
  DisputeEvidence,
  InvoiceDraft,
  InvoiceNotification,
  OrderTrackerRequest,
  PayPalLink,
  ShippingTracker,
} from "../paypal/types.js";
import type { ProposalKind } from "./store.js";

// Payload shapes, one per proposal kind. These are exactly what the seller sees
// before approving, and exactly what is sent to PayPal after approval.

export interface CreateAndSendInvoicePayload {
  invoice: InvoiceDraft;
  notification: InvoiceNotification;
}
export interface SendReminderPayload {
  invoiceId: string;
  notification: InvoiceNotification;
}
export interface CreatePaymentLinkPayload {
  order: CreateOrderRequest;
}
export interface CaptureOrderPayload {
  orderId: string;
}
export interface AddOrderTrackingPayload {
  orderId: string;
  tracker: OrderTrackerRequest;
}
export interface AddInvoiceTrackingPayload {
  trackers: ShippingTracker[];
}
export interface EvidenceAttachment {
  name: string;
  contentType: "application/pdf" | "image/png";
  /** Base64 of the file bytes. */
  base64: string;
}
export interface ProvideEvidencePayload {
  disputeId: string;
  evidences: DisputeEvidence[];
  attachments: EvidenceAttachment[];
}
export interface SendDisputeMessagePayload {
  disputeId: string;
  message: string;
}
export interface AcceptClaimPayload {
  disputeId: string;
  note: string;
}
export interface SeedDemoDataPayload {
  invoices?: CreateAndSendInvoicePayload[];
  orders?: CreatePaymentLinkPayload[];
}

export interface PayloadByKind {
  create_and_send_invoice: CreateAndSendInvoicePayload;
  send_invoice_reminder: SendReminderPayload;
  create_payment_link: CreatePaymentLinkPayload;
  capture_order: CaptureOrderPayload;
  add_order_tracking: AddOrderTrackingPayload;
  add_invoice_tracking: AddInvoiceTrackingPayload;
  provide_dispute_evidence: ProvideEvidencePayload;
  send_dispute_message: SendDisputeMessagePayload;
  accept_dispute_claim: AcceptClaimPayload;
  seed_demo_data: SeedDemoDataPayload;
}

/** The link a buyer opens to pay an order: `payer-action` (payment_source flow) or `approve`. */
export function payerLinkOf(links: PayPalLink[] | undefined): string | undefined {
  return (links?.find((l) => l.rel === "payer-action") ?? links?.find((l) => l.rel === "approve"))?.href;
}

async function createAndSend(paypal: PayPalClient, p: CreateAndSendInvoicePayload) {
  const invoice: InvoiceDraft = structuredClone(p.invoice) as InvoiceDraft;
  if (!invoice.detail.invoice_number) {
    invoice.detail.invoice_number = await paypal.generateNextInvoiceNumber();
  }
  const created = await paypal.createDraftInvoice(invoice);
  const link = await paypal.sendInvoice(created.id, p.notification);
  return { invoiceId: created.id, invoiceNumber: invoice.detail.invoice_number, payerLink: link?.href };
}

async function createLink(paypal: PayPalClient, p: CreatePaymentLinkPayload) {
  const order = await paypal.createOrder(p.order);
  return { orderId: order.id, status: order.status, payerLink: payerLinkOf(order.links) };
}

/**
 * The only place in the app that calls PayPal write methods.
 * Used by ProposalStore.approve().
 */
export function createPayPalExecutor(getPayPal: () => PayPalClient) {
  return async (kind: ProposalKind, payload: unknown): Promise<unknown> => {
    const paypal = getPayPal();
    switch (kind) {
      case "create_and_send_invoice":
        return createAndSend(paypal, payload as CreateAndSendInvoicePayload);
      case "send_invoice_reminder": {
        const p = payload as SendReminderPayload;
        await paypal.remindInvoice(p.invoiceId, p.notification);
        return { invoiceId: p.invoiceId, reminded: true };
      }
      case "create_payment_link":
        return createLink(paypal, payload as CreatePaymentLinkPayload);
      case "capture_order": {
        const p = payload as CaptureOrderPayload;
        const order = await paypal.captureOrder(p.orderId);
        const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
        return { orderId: order.id, status: order.status, captureId: capture?.id };
      }
      case "add_order_tracking": {
        const p = payload as AddOrderTrackingPayload;
        const order = await paypal.addOrderTracking(p.orderId, p.tracker);
        return { orderId: order.id, status: order.status };
      }
      case "add_invoice_tracking": {
        const p = payload as AddInvoiceTrackingPayload;
        return paypal.addTrackersBatch(p.trackers);
      }
      case "provide_dispute_evidence": {
        const p = payload as ProvideEvidencePayload;
        const files = p.attachments.map((a) => ({
          name: a.name,
          contentType: a.contentType,
          data: new Uint8Array(Buffer.from(a.base64, "base64")),
        }));
        return paypal.provideDisputeEvidence(p.disputeId, p.evidences, files);
      }
      case "send_dispute_message": {
        const p = payload as SendDisputeMessagePayload;
        return paypal.sendDisputeMessage(p.disputeId, p.message);
      }
      case "accept_dispute_claim": {
        const p = payload as AcceptClaimPayload;
        return paypal.acceptDisputeClaim(p.disputeId, p.note);
      }
      case "seed_demo_data": {
        const p = payload as SeedDemoDataPayload;
        const results: unknown[] = [];
        for (const inv of p.invoices ?? []) results.push(await createAndSend(paypal, inv));
        for (const o of p.orders ?? []) results.push(await createLink(paypal, o));
        return { created: results };
      }
    }
  };
}
