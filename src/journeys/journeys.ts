import type { DemoBuyers } from "../demo/buyers.js";
import type { Invoice, Money } from "../paypal/types.js";
import { publicProposal } from "../http/dto.js";
import { sellerActionState } from "../paypal/dispute-actions.js";
import type { Proposal } from "../proposals/store.js";
import { disputeMatchesSale, type DisputeView } from "./disputes.js";
import { COUNTRIES, parseSaleMarker, type Sale, type SaleRegistry } from "./sales.js";

// Builds the "transaction journey" view (S3): one sale followed through five steps
// (Draft, Invoice, Paid, Tracking, Delivered) with an exception branch for disputes. The
// journey is computed on every read from three sources: the sale registry (what this app
// started), PayPal (invoice status, payments, disputes) and the visitor's own proposals.

export type StepState = "done" | "current" | "todo";
export type JourneyStage = "draft" | "invoiced" | "paid" | "shipped" | "delivered";

const PAID = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL", "PARTIALLY_REFUNDED", "REFUNDED", "MARKED_AS_REFUNDED", "REFUNDED_EXTERNAL"]);
const SENT = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "PAYMENT_PENDING", "SCHEDULED", "SHARED"]);
const OPEN_PROBLEM = new Set<Proposal["status"]>(["failed", "unknown", "obsolete"]);

/** Proposal kinds by the journey step they act on. */
const STEP_OF_KIND: Record<string, number> = {
  create_and_send_invoice: 2,
  create_payment_link: 2,
  send_invoice_reminder: 3,
  capture_order: 3,
  add_invoice_tracking: 4,
  add_order_tracking: 4,
};
const DISPUTE_KINDS = new Set(["provide_dispute_evidence", "send_dispute_message", "accept_dispute_claim"]);

export type JourneyAction = "prepare_invoice" | "remind" | "add_tracking" | "build_evidence" | "simulate_payment" | "simulate_dispute" | "simulate_delivery";

/** Learns from a PayPal invoice: payment, transaction id, number, amount. Adds activity once. */
export function absorbInvoice(registry: SaleRegistry, sale: Sale, inv: Invoice): void {
  if (inv.detail?.invoice_number) sale.invoiceNumber = inv.detail.invoice_number;
  if (!sale.amount && inv.amount?.value) sale.amount = { currency_code: inv.amount.currency_code ?? inv.detail.currency_code, value: inv.amount.value };
  const tx = (inv.payments?.transactions ?? []).find((t) => t.payment_id);
  if (tx?.payment_id && !sale.transactionId) sale.transactionId = tx.payment_id;
  if (inv.status && PAID.has(inv.status) && !sale.paidAt) {
    sale.paidAt = tx?.payment_date ? new Date(`${tx.payment_date.slice(0, 10)}T12:00:00Z`).toISOString() : new Date().toISOString();
    registry.note(sale, "Buyer paid the invoice through PayPal", sale.paidAt);
  }
}

/** A sale rebuilt from one of this app's invoices after a restart (marker in detail.reference). */
export function saleFromInvoice(inv: Invoice, buyers: DemoBuyers): Sale | undefined {
  const marker = parseSaleMarker(inv.detail?.reference);
  if (!marker) return undefined;
  const email = inv.primary_recipients?.[0]?.billing_info?.email_address;
  const created = inv.detail?.invoice_date ? new Date(`${inv.detail.invoice_date}T00:00:00Z`).toISOString() : new Date().toISOString();
  return {
    id: marker.saleId,
    owner: "",
    createdAt: created,
    titleEn: inv.items?.[0]?.name ?? `Invoice ${inv.detail?.invoice_number ?? inv.id}`,
    buyerAlias: (email && buyers.aliasOf(email)) ?? "Demo buyer",
    country: marker.country,
    ...(inv.amount?.value ? { amount: { currency_code: inv.amount.currency_code ?? inv.detail.currency_code, value: inv.amount.value } } : {}),
    path: "invoice",
    invoiceId: inv.id,
    ...(inv.detail?.invoice_number ? { invoiceNumber: inv.detail.invoice_number } : {}),
    activity: [{ at: created, text: "Invoice sent via PayPal (recovered from PayPal after a restart)" }],
  };
}

/** The dispute about this sale's payment (an open one first, if the buyer opened several). */
function disputeOf(sale: Sale, disputes: DisputeView[]): DisputeView | undefined {
  const mine = disputes.filter((v) => disputeMatchesSale(v.dispute, sale));
  return mine.find((v) => v.dispute.status !== "RESOLVED") ?? mine[0];
}

function money(m: Money | undefined): Money | undefined {
  return m?.value ? { currency_code: m.currency_code, value: m.value } : undefined;
}

export interface JourneyContext {
  sales: Sale[];
  invoices: Map<string, Invoice>;
  /** PayPal's dispute list plus disputes known from webhooks or by id. */
  disputes: DisputeView[];
  /** The visitor's proposals (any status), newest first. */
  proposals: Proposal[];
  offline: boolean;
  buyers: DemoBuyers;
  registry: SaleRegistry;
}

/** One journey as the UI shows it. */
export function buildJourney(sale: Sale, ctx: JourneyContext) {
  const inv = sale.invoiceId ? ctx.invoices.get(sale.invoiceId) : undefined;
  if (inv) absorbInvoice(ctx.registry, sale, inv);
  const status = inv?.status;
  const mine = ctx.proposals.filter((p) => p.saleId === sale.id);
  const pendingFor = (step: number) => mine.find((p) => p.status === "pending" && STEP_OF_KIND[p.kind] === step);
  const problemFor = (step: number) => {
    const latest = mine.find((p) => STEP_OF_KIND[p.kind] === step && p.status !== "rejected" && p.status !== "expired");
    return latest && OPEN_PROBLEM.has(latest.status) ? latest : undefined;
  };

  const billed = Boolean(sale.orderId) || (status ? status !== "DRAFT" && status !== "CANCELLED" : Boolean(sale.invoiceId));
  const paid = sale.path === "order" ? Boolean(sale.captureId) : Boolean(status && PAID.has(status)) || Boolean(sale.paidAt);
  const tracked = Boolean(sale.tracking);
  const delivered = Boolean(sale.deliveredAt);
  const done = [true, billed, paid, tracked, delivered];
  const current = done.indexOf(false) + 1 || 6; // 1-based; 6 = all done

  // Only a payment can be disputed: the invoice transaction id or the order capture id.
  const disputeView = sale.transactionId || sale.captureId || paid ? disputeOf(sale, ctx.disputes) : undefined;
  const dispute = disputeView?.dispute;
  if (dispute && !sale.activity.some((a) => a.text.startsWith("Buyer opened a dispute"))) {
    ctx.registry.note(sale, "Buyer opened a dispute", dispute.create_time ?? new Date().toISOString());
  }
  const disputeOpen = Boolean(dispute && dispute.status !== "RESOLVED");

  const label = (n: number): string => {
    const pending = pendingFor(n);
    const problem = problemFor(n);
    if (pending) return "Awaiting approval";
    if (problem && !done[n - 1]) return problem.status === "unknown" ? "Needs checking" : "Needs attention";
    switch (n) {
      case 1:
        return "English listing ready";
      case 2:
        return billed ? (sale.path === "order" ? "Payment link created" : `Invoice ${sale.invoiceNumber ?? "sent"}`) : current === 2 ? "Ready to bill" : "Invoice";
      case 3:
        return paid ? "Payment received" : current === 3 ? "Waiting for buyer" : "Waiting for buyer";
      case 4:
        return tracked ? `${sale.tracking!.carrier} ${sale.tracking!.number}` : current === 4 ? "Add tracking after shipment" : "After shipment";
      default:
        return delivered ? "Delivered" : current === 5 ? "In transit" : "Delivery confirmation";
    }
  };
  const steps = (["Draft", "Invoice", "Paid", "Tracking", "Delivered"] as const).map((name, i) => ({
    n: i + 1,
    name,
    state: (done[i] ? "done" : i + 1 === current ? "current" : "todo") as StepState,
    label: label(i + 1),
  }));

  // What the current step needs, attached to that step (S3 callout).
  const callout = (() => {
    if (current > 5) return undefined;
    const pending = pendingFor(current);
    if (pending) return { step: current, kind: "proposal" as const, proposal: publicProposal(pending, ctx.buyers) };
    const problem = problemFor(current);
    const actions: JourneyAction[] = [];
    if (current === 2 && sale.listing) actions.push("prepare_invoice");
    if (current === 3 && sale.path === "invoice") {
      actions.push("remind");
      if (ctx.offline) actions.push("simulate_payment");
    }
    if (current === 3 && sale.path === "order" && ctx.offline) actions.push("simulate_payment");
    if (current === 4) actions.push("add_tracking");
    if (current === 5 && ctx.offline) actions.push("simulate_delivery");
    return { step: current, kind: "action" as const, actions, ...(problem ? { problem: publicProposal(problem, ctx.buyers) } : {}) };
  })();
  // A quieter hint for the step after the current one (S3: "Claude · Add tracking after shipment").
  const hint = current <= 3 ? { step: 4, text: "Add tracking after shipment" } : undefined;

  const disputeProposals = dispute ? mine.filter((p) => DISPUTE_KINDS.has(p.kind) && (p.payload as { disputeId?: string })?.disputeId === dispute.dispute_id) : [];
  const stage: JourneyStage = delivered ? "delivered" : tracked ? "shipped" : paid ? "paid" : billed ? "invoiced" : "draft";

  return {
    id: sale.id,
    title_ja: sale.titleJa,
    title_en: sale.titleEn,
    buyer: sale.buyerAlias,
    country: sale.country,
    country_name: COUNTRIES[sale.country] ?? sale.country,
    amount: money(sale.amount),
    path: sale.path,
    invoice_id: sale.invoiceId,
    invoice_number: sale.invoiceNumber,
    invoice_status: status,
    order_id: sale.orderId,
    capture_id: sale.captureId,
    tracking: sale.tracking,
    created_at: sale.createdAt,
    drafted_by: sale.draftedBy,
    listing: sale.listing,
    stage,
    current_step: current,
    steps,
    callout,
    hint,
    dispute: dispute
      ? {
          dispute_id: dispute.dispute_id,
          status: dispute.status,
          reason: dispute.reason,
          stage: dispute.dispute_life_cycle_stage,
          amount: money(dispute.dispute_amount),
          due: dispute.seller_response_due_date,
          open: disputeOpen,
          from_step: tracked ? 4 : 3,
          /** False while PayPal's list does not return the case yet (known by webhook or by id). */
          in_paypal_list: disputeView!.inList,
          // Only known from a read by id (list items carry no action links).
          ...(disputeView!.detailed ? sellerActionState(dispute) : {}),
          proposals: disputeProposals.filter((p) => p.status === "pending").map((p) => publicProposal(p, ctx.buyers)),
        }
      : undefined,
    can_simulate_dispute: ctx.offline && paid && !dispute && sale.path === "invoice",
    activity: sale.activity.slice(-12),
  };
}

export type Journey = ReturnType<typeof buildJourney>;

export function journeyCounts(journeys: Journey[]) {
  const c = { draft: 0, invoiced: 0, paid: 0, shipped: 0, disputed: 0 };
  for (const j of journeys) {
    if (j.stage === "draft") c.draft += 1;
    else if (j.stage === "invoiced") c.invoiced += 1;
    else if (j.stage === "paid") c.paid += 1;
    else c.shipped += 1;
    if (j.dispute?.open) c.disputed += 1;
  }
  return c;
}
