import type { DemoBuyers } from "../demo/buyers.js";
import type { PayPalApi } from "../paypal/offline.js";
import type {
  CreateOrderRequest,
  DisputeEvidence,
  InvoiceDraft,
  InvoiceNotification,
  OrderTrackerRequest,
  PayPalLink,
  ShippingTracker,
} from "../paypal/types.js";
import { PayPalApiError } from "../paypal/client.js";
import { disputeActions, type DisputeAction } from "../paypal/dispute-actions.js";
import type { OrderRegistry } from "./order-registry.js";
import { REMINDERS_PER_INVOICE_PER_DAY, type ReminderLedger } from "./reminder-ledger.js";
import { ProposalObsoleteError, ProposalPolicyError, type ExecutionContext, type ProposalKind } from "./store.js";

// Payload shapes, one per proposal kind. These are what the seller sees before approving
// and what is sent to PayPal after approval. Recipients are stored by demo alias
// ("Demo buyer 1"); the executor resolves the alias to the sandbox email right before the
// PayPal call, so the address never appears in a proposal.

export interface CreateAndSendInvoicePayload {
  /** A DEMO_BUYER_EMAILS alias; becomes primary_recipients[0].billing_info.email_address. */
  recipient_alias: string;
  invoice: InvoiceDraft;
  /** Send flags (the client never sends a subject or note; PayPal would ignore them). */
  notification: InvoiceNotification;
}
/** PayPal's standard reminder: only the send flags (PayPal ignores custom subject/note). */
export interface SendReminderPayload {
  invoiceId: string;
  notification: Pick<InvoiceNotification, "send_to_recipient" | "send_to_invoicer">;
}
export interface CreatePaymentLinkPayload {
  /** A DEMO_BUYER_EMAILS alias; becomes payment_source.paypal.email_address (the PayPal account the link is for). */
  recipient_alias: string;
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

export interface ExecutorOptions {
  /** The allowlist of recipients (DEMO_BUYER_EMAILS). */
  buyers: DemoBuyers;
  /** Orders created here are registered to the proposal's session (for capture). */
  orders?: OrderRegistry;
  /** At most 2 reminders per invoice per day. */
  reminders?: ReminderLedger;
}

function resolveRecipient(buyers: DemoBuyers, alias: unknown): string {
  const buyer = typeof alias === "string" ? buyers.resolve(alias) : undefined;
  if (!buyer) {
    throw new ProposalPolicyError(
      buyers.size === 0
        ? "No demo buyers are configured (DEMO_BUYER_EMAILS), so nothing can be sent on this demo."
        : `Invoices and payment links can only go to the demo buyers (${buyers.aliases.join(", ")}).`,
    );
  }
  return buyer.email;
}

/** Builds the invoice that is sent: the stored draft plus the resolved demo-buyer recipient. */
export function invoiceForRecipient(buyers: DemoBuyers, p: CreateAndSendInvoicePayload): { invoice: InvoiceDraft; notification: InvoiceNotification } {
  const email = resolveRecipient(buyers, p.recipient_alias);
  if (p.invoice.primary_recipients?.length || p.notification.additional_recipients?.length) {
    throw new ProposalPolicyError("This invoice names recipients directly; on this demo invoices only go to demo buyers chosen by alias.");
  }
  const invoice = structuredClone(p.invoice) as InvoiceDraft;
  invoice.primary_recipients = [{ billing_info: { email_address: email } }];
  return { invoice, notification: structuredClone(p.notification) as InvoiceNotification };
}

/** Builds the order that is sent: the stored order plus the resolved demo-buyer PayPal account. */
export function orderForRecipient(buyers: DemoBuyers, p: CreatePaymentLinkPayload): CreateOrderRequest {
  const email = resolveRecipient(buyers, p.recipient_alias);
  const order = structuredClone(p.order) as CreateOrderRequest;
  if (order.payment_source?.paypal?.email_address !== undefined) {
    throw new ProposalPolicyError("This payment link names a PayPal account directly; on this demo links only go to demo buyers chosen by alias.");
  }
  order.payment_source = { ...order.payment_source, paypal: { ...order.payment_source?.paypal, email_address: email } };
  return order;
}

async function createAndSend(paypal: PayPalApi, buyers: DemoBuyers, p: CreateAndSendInvoicePayload) {
  const { invoice, notification } = invoiceForRecipient(buyers, p);
  if (!invoice.detail.invoice_number) {
    invoice.detail.invoice_number = await paypal.generateNextInvoiceNumber();
  }
  const created = await paypal.createDraftInvoice(invoice);
  const link = await paypal.sendInvoice(created.id, notification);
  return { invoiceId: created.id, invoiceNumber: invoice.detail.invoice_number, recipient: p.recipient_alias, payerLink: link?.href };
}

async function createLink(paypal: PayPalApi, opts: ExecutorOptions, p: CreatePaymentLinkPayload, ctx: ExecutionContext) {
  const order = await paypal.createOrder(orderForRecipient(opts.buyers, p));
  opts.orders?.register(order.id, ctx.owner);
  return { orderId: order.id, status: order.status, recipient: p.recipient_alias, payerLink: payerLinkOf(order.links) };
}

/**
 * Re-reads the dispute right before a dispute write and refuses (obsolete) when PayPal no
 * longer allows that action. The approved payload is never changed.
 */
async function requireDisputeAction(paypal: PayPalApi, disputeId: string, action: DisputeAction): Promise<void> {
  const verdict = disputeActions(await paypal.getDispute(disputeId))[action];
  if (!verdict.allowed) throw new ProposalObsoleteError(`${verdict.reason} Nothing was sent. Build a new proposal if the dispute changes.`);
}

/**
 * The only place in the app that calls PayPal write methods.
 * Used by ProposalStore.approve().
 */
export function createPayPalExecutor(getPayPal: (owner: string) => PayPalApi, opts: ExecutorOptions) {
  return async (kind: ProposalKind, payload: unknown, ctx: ExecutionContext): Promise<unknown> => {
    const paypal = getPayPal(ctx.owner);
    switch (kind) {
      case "create_and_send_invoice":
        return createAndSend(paypal, opts.buyers, payload as CreateAndSendInvoicePayload);
      case "send_invoice_reminder": {
        const p = payload as SendReminderPayload;
        if (opts.reminders && !opts.reminders.reserve(p.invoiceId)) {
          throw new ProposalObsoleteError(
            `PayPal allows at most ${REMINDERS_PER_INVOICE_PER_DAY} reminders per invoice per day, and invoice ${p.invoiceId} already had them today. Nothing was sent; try again tomorrow.`,
          );
        }
        try {
          // Flags only: PayPal sends its standard reminder text.
          await paypal.remindInvoice(p.invoiceId, { send_to_recipient: p.notification.send_to_recipient ?? true, send_to_invoicer: p.notification.send_to_invoicer ?? true });
        } catch (err) {
          if (err instanceof PayPalApiError) opts.reminders?.release(p.invoiceId); // PayPal refused: not sent
          throw err;
        }
        return { invoiceId: p.invoiceId, reminded: true, standardReminder: true };
      }
      case "create_payment_link":
        return createLink(paypal, opts, payload as CreatePaymentLinkPayload, ctx);
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
        await requireDisputeAction(paypal, p.disputeId, "provide_evidence");
        const files = p.attachments.map((a) => ({
          name: a.name,
          contentType: a.contentType,
          data: new Uint8Array(Buffer.from(a.base64, "base64")),
        }));
        return paypal.provideDisputeEvidence(p.disputeId, p.evidences, files);
      }
      case "send_dispute_message": {
        const p = payload as SendDisputeMessagePayload;
        await requireDisputeAction(paypal, p.disputeId, "send_message");
        return paypal.sendDisputeMessage(p.disputeId, p.message);
      }
      case "accept_dispute_claim": {
        const p = payload as AcceptClaimPayload;
        await requireDisputeAction(paypal, p.disputeId, "accept_claim");
        return paypal.acceptDisputeClaim(p.disputeId, p.note);
      }
      case "seed_demo_data": {
        const p = payload as SeedDemoDataPayload;
        const results: unknown[] = [];
        // Check every recipient before the first write, so a bad entry cannot leave a partial seed.
        for (const inv of p.invoices ?? []) invoiceForRecipient(opts.buyers, inv);
        for (const o of p.orders ?? []) orderForRecipient(opts.buyers, o);
        for (const inv of p.invoices ?? []) results.push(await createAndSend(paypal, opts.buyers, inv));
        for (const o of p.orders ?? []) results.push(await createLink(paypal, opts, o, ctx));
        return { created: results };
      }
    }
  };
}
