// Public views of internal and PayPal objects (F3). The API returns only these small DTOs,
// never full PayPal records. Recipients appear by demo alias; any other email address is
// masked (and sendJson masks every response once more as a safety net).
import type { EvidencePack } from "../agent/tasks.js";
import type { DemoBuyers } from "../demo/buyers.js";
import type { Dispute, DisputeSummary, Invoice, Money, OrderResponse } from "../paypal/types.js";
import { disputeActions, sellerActionState } from "../paypal/dispute-actions.js";
import { maskEmail } from "../privacy/mask.js";
import { redactPersonalData } from "../privacy/redact.js";
import type { Proposal } from "../proposals/store.js";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Replaces demo-buyer emails by their alias and masks every other email, in any JSON value. */
export function aliasEmails<T>(value: T, buyers: DemoBuyers | undefined, depth = 0): T {
  if (depth > 40) return value;
  if (typeof value === "string") {
    return (value.includes("@") ? value.replace(EMAIL, (m) => buyers?.aliasOf(m) ?? maskEmail(m)) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => aliasEmails(v, buyers, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Attachments: show what is attached, not the base64 bytes.
      if (k === "base64" && typeof v === "string") out.bytes = Math.floor((v.length * 3) / 4);
      else out[k] = aliasEmails(v, buyers, depth + 1);
    }
    return out as T;
  }
  return value;
}

/** What a visitor sees of one of their proposals. The owner session id is never returned. */
export function publicProposal(p: Proposal, buyers?: DemoBuyers) {
  return {
    id: p.id,
    kind: p.kind,
    title: aliasEmails(p.title, buyers),
    status: p.status,
    createdAt: p.createdAt,
    ...(p.decidedAt ? { decidedAt: p.decidedAt } : {}),
    payload: aliasEmails(p.payload, buyers),
    ...(p.copyForDm ? { copy_for_dm: aliasEmails(p.copyForDm, buyers) } : {}),
    ...(p.saleId ? { sale_id: p.saleId } : {}),
    ...(p.result !== undefined ? { result: aliasEmails(p.result, buyers) } : {}),
    ...(p.error !== undefined ? { error: aliasEmails(p.error, buyers) } : {}),
  };
}

export type PublicProposal = ReturnType<typeof publicProposal>;

function recipientOf(inv: Invoice, buyers: DemoBuyers): string | undefined {
  const email = inv.primary_recipients?.[0]?.billing_info?.email_address;
  if (!email) return undefined;
  return buyers.aliasOf(email) ?? maskEmail(email);
}

function money(m: { currency_code?: string; value?: string } | undefined): Money | undefined {
  return m?.value && m.currency_code ? { currency_code: m.currency_code, value: m.value } : undefined;
}

/** One row of the invoice grid. */
export function invoiceRow(inv: Invoice, buyers: DemoBuyers) {
  const amount = money({ currency_code: inv.amount?.currency_code ?? inv.detail?.currency_code, ...(inv.amount?.value ? { value: inv.amount.value } : {}) });
  return {
    id: inv.id,
    invoice_number: inv.detail?.invoice_number,
    status: inv.status,
    invoice_date: inv.detail?.invoice_date,
    due_date: inv.detail?.payment_term?.due_date,
    ...(amount ? { amount } : {}),
    ...(inv.due_amount ? { due_amount: money(inv.due_amount) } : {}),
    recipient: recipientOf(inv, buyers),
    item_names: (inv.items ?? []).map((i) => i.name).slice(0, 20),
    transaction_ids: (inv.payments?.transactions ?? []).map((t) => t.payment_id).filter((x): x is string => Boolean(x)),
    payer_view_url: inv.detail?.metadata?.recipient_view_url,
  };
}

/** One invoice: the row plus items and paid amount. No invoicer or billing details, no memo. */
export function invoiceDetail(inv: Invoice, buyers: DemoBuyers) {
  return {
    ...invoiceRow(inv, buyers),
    items: (inv.items ?? []).slice(0, 50).map((i) => ({ name: i.name, quantity: i.quantity, ...(i.unit_amount ? { unit_amount: money(i.unit_amount) } : {}) })),
    ...(inv.payments?.paid_amount ? { paid_amount: money(inv.payments.paid_amount) } : {}),
  };
}

export function disputeRow(d: DisputeSummary) {
  return {
    dispute_id: d.dispute_id,
    reason: d.reason,
    status: d.status,
    dispute_state: d.dispute_state,
    stage: d.dispute_life_cycle_stage,
    amount: money(d.dispute_amount),
    create_time: d.create_time,
    seller_response_due_date: d.seller_response_due_date,
  };
}

/** One dispute: summary, transaction ids, messages (contact details redacted) and what PayPal allows now. */
export function disputeDetail(d: Dispute) {
  return {
    ...disputeRow(d),
    allowed_actions: disputeActions(d),
    ...sellerActionState(d),
    update_time: d.update_time,
    disputed_transactions: (d.disputed_transactions ?? []).slice(0, 10).map((t) => ({
      seller_transaction_id: t.seller_transaction_id,
      invoice_number: t.invoice_number,
      gross_amount: money(t.gross_amount),
    })),
    messages: (d.messages ?? []).slice(-30).map((m) => ({ posted_by: m.posted_by, time_posted: m.time_posted, content: redactPersonalData((m.content ?? "").slice(0, 2000)) })),
  };
}

export function orderView(o: OrderResponse) {
  return {
    id: o.id,
    status: o.status,
    captures: (o.purchase_units ?? []).flatMap((u) => u.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status, ...(c.amount ? { amount: money(c.amount) } : {}) })),
  };
}

/** The evidence pack without its internal payloads (the proposals carry those). */
export function publicPack(pack: EvidencePack) {
  const { evidence_payload: _e, message_payload: _m, ...rest } = pack;
  return rest;
}
