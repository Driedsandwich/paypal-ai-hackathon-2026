import { z } from "zod";
import type { AiMessage, AiProvider, AiToolSpec } from "../ai/provider.js";
import { carrierFor } from "../paypal/carriers.js";
import type { PayPalClient } from "../paypal/client.js";
import type { Invoice } from "../paypal/types.js";
import type { DemoBuyers } from "../demo/buyers.js";
import type { ReminderLedger } from "../proposals/reminder-ledger.js";
import type { ProposalKind, ProposalStore } from "../proposals/store.js";
import { showMoney } from "../money.js";
import { SellerMoneySchema } from "./schemas.js";
import { buildInvoicePayload, buildOrderPayload, standardReminderPayload, type AgentConfig } from "./tasks.js";

// Agent tools for the free-chat entry point. @paypal/agent-toolkit's AI SDK adapter
// does not work with the installed AI SDK (see docs/DECISIONS.md), so these are our
// own tools on top of PayPalClient. Names match the toolkit's where they overlap.
// Read tools run immediately; every tool that would change state at PayPal or reach
// a buyer only creates a proposal that the seller must approve.

export interface ToolDeps {
  paypal: PayPalClient | undefined;
  proposals: ProposalStore;
  agentConfig: AgentConfig;
  paymentPath: "invoice" | "order";
  /** Demo session of the visitor chatting; proposals created by tools belong to it. */
  sessionId: string;
  /** Recipients by alias (DEMO_BUYER_EMAILS). The model only ever sees aliases. */
  buyers: DemoBuyers;
  /** At most 2 reminders per invoice per day. */
  reminders?: ReminderLedger;
}

const NOT_CONFIGURED = { error: "PayPal is not configured on this server (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET)." };

/** Compact invoice view for the model: no buyer contact details. */
export function invoiceBrief(inv: Invoice) {
  return {
    id: inv.id,
    invoice_number: inv.detail?.invoice_number,
    status: inv.status,
    invoice_date: inv.detail?.invoice_date,
    due_date: inv.detail?.payment_term?.due_date,
    amount: inv.amount,
    due_amount: inv.due_amount,
  };
}

function tool<S extends z.ZodType>(name: string, description: string, inputSchema: S, run: (input: z.infer<S>) => Promise<unknown>): AiToolSpec {
  return { name, description, inputSchema, execute: (input) => run(input as z.infer<S>) };
}

function pending(p: { id: string; title: string }) {
  return { proposal_id: p.id, status: "pending_seller_approval", title: p.title, note: "Nothing was sent. The seller must approve this in the app." };
}

export function agentTools(deps: ToolDeps): AiToolSpec[] {
  const { paypal } = deps;
  const read = async <T>(fn: (pp: PayPalClient) => Promise<T>) => (paypal ? fn(paypal) : NOT_CONFIGURED);
  const proposals = {
    propose: <P>(kind: ProposalKind, title: string, payload: P, copyForDm?: string) =>
      deps.proposals.propose(kind, title, payload, { owner: deps.sessionId, ...(copyForDm ? { copyForDm } : {}) }),
  };

  const tools: AiToolSpec[] = [
    tool("list_invoices", "List the seller's recent PayPal invoices with status and amounts.", z.object({ page: z.number().int().min(1).max(100).optional(), page_size: z.number().int().min(1).max(50).optional() }), (i) =>
      read(async (pp) => {
        const list = await pp.listInvoices({ page: i.page ?? 1, page_size: i.page_size ?? 10, total_required: true });
        return { total_items: list.total_items, invoices: (list.items ?? []).map(invoiceBrief) };
      }),
    ),
    tool("get_invoice", "Get one PayPal invoice by id.", z.object({ invoice_id: z.string().min(1).max(30) }), (i) =>
      read(async (pp) => invoiceBrief(await pp.getInvoice(i.invoice_id))),
    ),
    tool("list_disputes", "List the seller's PayPal disputes.", z.object({ dispute_state: z.enum(["REQUIRED_ACTION", "REQUIRED_OTHER_PARTY_ACTION", "UNDER_PAYPAL_REVIEW", "RESOLVED", "OPEN_INQUIRIES", "APPEALABLE"]).optional() }), (i) =>
      read(async (pp) => {
        const list = await pp.listDisputes({ page_size: 20, ...(i.dispute_state ? { dispute_state: i.dispute_state } : {}) });
        return (list.items ?? []).map((d) => ({ dispute_id: d.dispute_id, reason: d.reason, status: d.status, amount: d.dispute_amount, seller_response_due_date: d.seller_response_due_date }));
      }),
    ),
    tool("get_dispute", "Get one PayPal dispute by id, including messages.", z.object({ dispute_id: z.string().min(1).max(255) }), (i) =>
      read(async (pp) => {
        const d = await pp.getDispute(i.dispute_id);
        return { dispute_id: d.dispute_id, reason: d.reason, status: d.status, stage: d.dispute_life_cycle_stage, amount: d.dispute_amount, messages: d.messages?.map((m) => ({ posted_by: m.posted_by, time_posted: m.time_posted, content: m.content })) };
      }),
    ),
    tool("get_order", "Get an Orders v2 order (payment link) by id.", z.object({ order_id: z.string().min(1).max(36) }), (i) =>
      read(async (pp) => {
        const o = await pp.getOrder(i.order_id);
        return { id: o.id, status: o.status, captures: o.purchase_units?.flatMap((u) => u.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status })) };
      }),
    ),
    tool(
      "send_invoice_reminder",
      "Propose sending PayPal's standard reminder email for an unpaid invoice (PayPal uses its own text; custom text is not sent; at most 2 per invoice per day). Optionally add a short friendly message the seller can copy into a DM to the buyer. The seller must approve.",
      z.object({ invoice_id: z.string().min(1).max(30), dm_message: z.string().min(10).max(1000).optional() }),
      async (i) => {
        if (deps.reminders && deps.reminders.remaining(i.invoice_id) <= 0) return { error: "This invoice already had 2 reminders today (PayPal's daily limit). Try again tomorrow." };
        return pending(proposals.propose("send_invoice_reminder", `Send PayPal's standard reminder for invoice ${i.invoice_id}`, standardReminderPayload(i.invoice_id), i.dm_message));
      },
    ),
    tool(
      "create_shipment_tracking",
      "Propose adding a tracking number at PayPal. Use order_id + capture_id for payment links, or transaction_id for invoice payments.",
      z.object({ carrier: z.string().min(1).max(64), tracking_number: z.string().min(1).max(64), order_id: z.string().max(36).optional(), capture_id: z.string().max(50).optional(), transaction_id: z.string().max(50).optional() }),
      async (i) => {
        if (i.order_id && i.capture_id) {
          return pending(
            proposals.propose("add_order_tracking", `Add ${i.carrier} tracking ${i.tracking_number} to order ${i.order_id}`, {
              orderId: i.order_id,
              tracker: { capture_id: i.capture_id, tracking_number: i.tracking_number, ...carrierFor(i.carrier, "orders"), notify_payer: true },
            }),
          );
        }
        if (i.transaction_id) {
          return pending(
            proposals.propose("add_invoice_tracking", `Add ${i.carrier} tracking ${i.tracking_number} to transaction ${i.transaction_id}`, {
              trackers: [{ transaction_id: i.transaction_id, tracking_number: i.tracking_number, status: "SHIPPED", ...carrierFor(i.carrier, "shipping"), notify_buyer: true }],
            }),
          );
        }
        return { error: "Give order_id and capture_id (payment link) or transaction_id (invoice payment)." };
      },
    ),
    tool("send_dispute_message", "Propose an English message to the buyer in a dispute. The seller must approve.", z.object({ dispute_id: z.string().min(1).max(255), message: z.string().min(1).max(2000) }), async (i) =>
      pending(proposals.propose("send_dispute_message", `Send message in dispute ${i.dispute_id}`, { disputeId: i.dispute_id, message: i.message })),
    ),
    tool("accept_dispute_claim", "Propose accepting a dispute claim (refunds the buyer). The seller must approve.", z.object({ dispute_id: z.string().min(1).max(255), note: z.string().min(1).max(2000) }), async (i) =>
      pending(proposals.propose("accept_dispute_claim", `Accept claim and refund in dispute ${i.dispute_id}`, { disputeId: i.dispute_id, note: i.note })),
    ),
  ];

  const aliases = deps.buyers.aliases;
  const buyerAlias = (aliases.length ? z.enum(aliases as [string, ...string[]]) : z.string().max(40)).describe(
    aliases.length ? `Demo buyer alias, one of: ${aliases.join(", ")}` : "Demo buyer alias (none are configured on this server)",
  );
  const noBuyers = { error: "No demo buyers are configured on this server (DEMO_BUYER_EMAILS), so invoices and payment links cannot be prepared." };
  const unknownBuyer = { error: `Unknown buyer. Use one of the demo buyer aliases: ${aliases.join(", ")}.` };
  const sale = z.object({
    buyer: buyerAlias,
    item_title: z.string().min(1).max(127),
    description: z.string().max(1000).optional(),
    price: SellerMoneySchema,
    quantity: z.number().int().min(1).max(999).optional(),
    note: z.string().min(10).max(1000).describe("Friendly note to the buyer (invoice note, or a DM text for payment links)"),
  });
  if (deps.paymentPath === "invoice") {
    tools.push(
      tool("create_invoice", "Propose creating and sending a PayPal invoice to a demo buyer (chosen by alias). The seller must approve.", sale, async (i) => {
        if (aliases.length === 0) return noBuyers;
        const buyer = deps.buyers.resolve(i.buyer);
        if (!buyer) return unknownBuyer;
        const listing = { title: i.item_title, description: i.description ?? "", price: i.price, quantity: i.quantity ?? 1 };
        const payload = buildInvoicePayload(listing, buyer.alias, { note: i.note }, deps.agentConfig.sellerBusinessName);
        return pending(proposals.propose("create_and_send_invoice", `Send invoice for ${showMoney(i.price)} to ${buyer.alias}: ${i.item_title}`, payload));
      }),
    );
  } else {
    tools.push(
      tool("create_order", "Propose creating a PayPal payment link (Orders v2) for a demo buyer (chosen by alias). The seller must approve.", sale, async (i) => {
        if (aliases.length === 0) return noBuyers;
        const buyer = deps.buyers.resolve(i.buyer);
        if (!buyer) return unknownBuyer;
        const listing = { title: i.item_title, description: i.description ?? "", price: i.price, quantity: i.quantity ?? 1 };
        return pending(proposals.propose("create_payment_link", `Create payment link for ${showMoney(i.price)} for ${buyer.alias}: ${i.item_title}`, buildOrderPayload(listing, buyer.alias, deps.agentConfig), i.note));
      }),
    );
  }
  return tools;
}

const CHAT_SYSTEM = `You are Okuri, an AI export desk for a small Japanese seller who sells to overseas buyers and gets paid with PayPal.
The seller may write in Japanese or English; answer in the seller's language, but write anything meant for buyers in English.
Use the tools to look up PayPal invoices, orders and disputes. Tools that change something at PayPal or contact a buyer only create proposals: tell the seller that they must approve each proposal in the app. Never claim something was sent.
Buyers are chosen by demo alias (for example "Demo buyer 1"); you never see or need email addresses.
Never invent invoice ids, amounts, tracking numbers or buyer details; ask the seller when something is missing.`;

export const ChatInputSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(4000) }))
    .min(1)
    .max(20),
});

export async function chat(ai: AiProvider, deps: ToolDeps, messages: AiMessage[], maxTokens: number) {
  const before = new Set(deps.proposals.list({ owner: deps.sessionId }).map((p) => p.id));
  const result = await ai.complete({
    task: "chat",
    messages: [{ role: "system", content: CHAT_SYSTEM }, ...messages],
    tools: agentTools(deps),
    maxTokens,
    maxSteps: 5,
  });
  const proposals = deps.proposals.list({ owner: deps.sessionId }).filter((p) => !before.has(p.id));
  return {
    reply: result.text,
    tool_calls: (result.toolCalls ?? []).map((c) => ({ name: c.name, input: c.input })),
    proposals,
    generated_by: { provider: result.provider, ...(result.model ? { model: result.model } : {}) },
  };
}
