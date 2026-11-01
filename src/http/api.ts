import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AiProvider } from "../ai/provider.js";
import { BuyerSchema, EvidenceInputSchema, JpItemSchema, ListingForSaleSchema, ShipmentFactsSchema, type EvidenceInput, type UnpaidInvoice } from "../agent/schemas.js";
import { Agent } from "../agent/tasks.js";
import { chat, ChatInputSchema, invoiceBrief } from "../agent/tools.js";
import type { AppSettings } from "../config.js";
import { DEMO_ITEMS } from "../demo/items.js";
import type { EventCategory, EventLog } from "../events/log.js";
import type { AiLimiter } from "../limits/rate-limit.js";
import { showMoney } from "../money.js";
import { carrierFor } from "../paypal/carriers.js";
import type { PayPalClient } from "../paypal/client.js";
import type { PayPalConfig } from "../paypal/config.js";
import type { Invoice } from "../paypal/types.js";
import type { SeedDemoDataPayload } from "../proposals/actions.js";
import { buildInvoicePayload, buildOrderPayload } from "../agent/tasks.js";
import { PROPOSAL_STATUSES, type ProposalStatus, type ProposalStore } from "../proposals/store.js";
import { clientAddress, limitKey } from "./client-address.js";
import { HttpError, ok, readJsonBody } from "./util.js";

export interface ApiDeps {
  settings: AppSettings;
  paypalConfig: PayPalConfig | undefined;
  paypal: PayPalClient | undefined;
  ai: AiProvider;
  agent: Agent;
  events: EventLog;
  proposals: ProposalStore;
  limiter: AiLimiter;
}

const MAX_API_BODY = 64 * 1024;
const UNPAID = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
const ID = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _ only");

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; query: URLSearchParams; deps: ApiDeps }) => Promise<void>;

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /** AI routes are rate limited and count toward the daily cap. */
  ai?: boolean;
  handler: Handler;
}

function requirePayPal(deps: ApiDeps): PayPalClient {
  if (!deps.paypal) {
    throw new HttpError(503, "paypal_not_configured", "PayPal is not configured on this server. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) to use this feature.");
  }
  return deps.paypal;
}

function bannerMessages(deps: ApiDeps): string[] {
  const out: string[] = [];
  if (!deps.paypal) out.push("PayPal is not configured: invoices, shipments and disputes are disabled. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) and restart.");
  if (deps.ai.name === "fake") out.push("AI runs in offline demo mode (AI_PROVIDER=fake): answers are rule-based, not from a real model.");
  if (deps.paypal && !deps.paypalConfig?.webhookId) out.push("PAYPAL_WEBHOOK_ID is not set: webhook events cannot be verified, so the event log stays empty.");
  return out;
}

export function healthData(deps: ApiDeps) {
  return {
    app: "okuri",
    paypal: { configured: Boolean(deps.paypal), env: deps.paypalConfig?.env ?? null, webhookConfigured: Boolean(deps.paypalConfig?.webhookId) },
    ai: { provider: deps.ai.name, model: deps.ai.model ?? null },
    paymentPath: deps.settings.paymentPath,
    fxJpyPerUsd: deps.settings.fxJpyPerUsd,
    limits: {
      perIp: deps.settings.aiRateLimitPerIp,
      windowMinutes: deps.settings.aiRateLimitWindowMinutes,
      dailyCap: deps.settings.aiDailyCap,
      maxOutputTokens: deps.settings.aiMaxOutputTokens,
      usedToday: deps.limiter.usage().usedToday,
    },
    demo: { buyerEmailsConfigured: deps.settings.demoBuyerEmails.length },
    agStudio: { licensed: deps.settings.agStudioLicensed },
    banner: bannerMessages(deps),
  };
}

function invoiceRow(inv: Invoice) {
  return {
    ...invoiceBrief(inv),
    recipient_email: inv.primary_recipients?.[0]?.billing_info?.email_address,
    item_names: (inv.items ?? []).map((i) => i.name),
    transaction_ids: (inv.payments?.transactions ?? []).map((t) => t.payment_id).filter(Boolean),
    payer_view_url: inv.detail?.metadata?.recipient_view_url,
  };
}

function amountOf(inv: Invoice): { amount?: { currency_code: string; value: string } } {
  if (inv.due_amount) return { amount: inv.due_amount };
  if (inv.amount?.value) return { amount: { currency_code: inv.amount.currency_code ?? inv.detail.currency_code, value: inv.amount.value } };
  return {};
}

function daysSince(date: string | undefined, now: number): number | undefined {
  if (!date) return undefined;
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : undefined;
}

const PrepareSchema = z.object({ listing: ListingForSaleSchema, buyer: BuyerSchema.optional() });

const TrackingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), order_id: ID, capture_id: ID, carrier: z.string().trim().min(1).max(64), tracking_number: z.string().trim().min(1).max(64), notify_buyer: z.boolean().default(true) }),
  z.object({
    kind: z.literal("invoice"),
    invoice_id: ID.optional(),
    transaction_id: ID.optional(),
    carrier: z.string().trim().min(1).max(64),
    tracking_number: z.string().trim().min(1).max(64),
    notify_buyer: z.boolean().default(true),
  }),
]);

const EvidenceRequestSchema = z.object({
  invoice_id: ID.optional(),
  tracking: ShipmentFactsSchema.optional(),
  seller_notes: z.string().max(2000).optional(),
});

const ROUTES: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handler: async ({ res, deps }) => ok(res, healthData(deps)),
  },
  {
    method: "GET",
    pattern: /^\/api\/demo\/items$/,
    handler: async ({ res }) => ok(res, DEMO_ITEMS.map((d) => ({ key: d.key, item: d.item }))),
  },
  {
    method: "POST",
    pattern: /^\/api\/listings\/draft$/,
    ai: true,
    handler: async ({ req, res, deps }) => {
      const { item } = z.object({ item: JpItemSchema }).parse(await readJsonBody(req, MAX_API_BODY));
      ok(res, await deps.agent.draftListing(item));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/invoices\/prepare$/,
    ai: true,
    handler: async ({ req, res, deps }) => {
      const body = PrepareSchema.parse(await readJsonBody(req, MAX_API_BODY));
      if (deps.settings.paymentPath === "order") {
        const prepared = await deps.agent.preparePaymentLink(body.listing);
        const proposal = deps.proposals.propose("create_payment_link", `Create payment link for ${showMoney(body.listing.price)}: ${body.listing.title}`, prepared.payload);
        return ok(res, { path: "order", proposal, buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
      }
      if (!body.buyer) throw new HttpError(400, "invalid_input", "buyer.email is required on the invoice path");
      const prepared = await deps.agent.prepareInvoice(body.listing, body.buyer);
      const proposal = deps.proposals.propose("create_and_send_invoice", `Send invoice for ${showMoney(body.listing.price)}: ${body.listing.title}`, prepared.payload);
      ok(res, { path: "invoice", proposal, buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/payment-links\/prepare$/,
    ai: true,
    handler: async ({ req, res, deps }) => {
      const body = PrepareSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const prepared = await deps.agent.preparePaymentLink(body.listing);
      const proposal = deps.proposals.propose("create_payment_link", `Create payment link for ${showMoney(body.listing.price)}: ${body.listing.title}`, prepared.payload);
      ok(res, { path: "order", proposal, buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/invoices$/,
    handler: async ({ res, deps, query }) => {
      const page = z.coerce.number().int().min(1).max(1000).catch(1).parse(query.get("page") ?? 1);
      const list = await requirePayPal(deps).listInvoices({ page, page_size: 20, total_required: true });
      ok(res, { total_items: list.total_items ?? null, total_pages: list.total_pages ?? null, page, invoices: (list.items ?? []).map(invoiceRow) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/invoices\/nudge$/,
    ai: true,
    handler: async ({ req, res, deps }) => {
      const body = z.object({ invoice_ids: z.array(ID).max(20).optional() }).parse(await readJsonBody(req, MAX_API_BODY));
      const list = await requirePayPal(deps).listInvoices({ page: 1, page_size: 50 });
      const wanted = body.invoice_ids ? new Set(body.invoice_ids) : undefined;
      const now = Date.now();
      const unpaid: UnpaidInvoice[] = (list.items ?? [])
        .filter((inv) => inv.status && UNPAID.has(inv.status) && (!wanted || wanted.has(inv.id)))
        .slice(0, 20)
        .map((inv) => ({
          invoice_id: inv.id,
          ...(inv.detail?.invoice_number ? { invoice_number: inv.detail.invoice_number } : {}),
          ...amountOf(inv),
          ...(inv.detail?.invoice_date ? { invoice_date: inv.detail.invoice_date } : {}),
          ...(inv.detail?.payment_term?.due_date ? { due_date: inv.detail.payment_term.due_date } : {}),
          ...(daysSince(inv.detail?.invoice_date, now) !== undefined ? { days_outstanding: daysSince(inv.detail?.invoice_date, now)! } : {}),
          item_names: (inv.items ?? []).map((i) => i.name).slice(0, 20),
        }));
      const { reminders, generated_by } = await deps.agent.nudgeUnpaid(unpaid);
      const proposals = reminders.map((r) => deps.proposals.propose("send_invoice_reminder", `Send reminder for invoice ${r.invoice_id}`, r.payload));
      ok(res, { unpaid_count: unpaid.length, proposals, generated_by });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/invoices\/([A-Za-z0-9_-]+)$/,
    handler: async ({ res, deps, params }) => ok(res, await requirePayPal(deps).getInvoice(params[0]!)),
  },
  {
    method: "GET",
    pattern: /^\/api\/orders\/([A-Za-z0-9_-]+)$/,
    handler: async ({ res, deps, params }) => {
      const o = await requirePayPal(deps).getOrder(params[0]!);
      ok(res, {
        id: o.id,
        status: o.status,
        captures: (o.purchase_units ?? []).flatMap((u) => u.payments?.captures ?? []).map((c) => ({ id: c.id, status: c.status, amount: c.amount })),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/orders\/([A-Za-z0-9_-]+)\/capture$/,
    handler: async ({ req, res, deps, params }) => {
      await readJsonBody(req, MAX_API_BODY);
      requirePayPal(deps);
      ok(res, { proposal: deps.proposals.propose("capture_order", `Capture payment for order ${params[0]}`, { orderId: params[0]! }) }, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tracking$/,
    handler: async ({ req, res, deps }) => {
      const body = TrackingSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const paypal = requirePayPal(deps);
      if (body.kind === "order") {
        const proposal = deps.proposals.propose("add_order_tracking", `Add ${body.carrier} tracking ${body.tracking_number} to order ${body.order_id}`, {
          orderId: body.order_id,
          tracker: { capture_id: body.capture_id, tracking_number: body.tracking_number, ...carrierFor(body.carrier, "orders"), notify_payer: body.notify_buyer },
        });
        return ok(res, { proposal }, 201);
      }
      let transactionId = body.transaction_id;
      if (!transactionId && body.invoice_id) {
        const inv = await paypal.getInvoice(body.invoice_id);
        transactionId = (inv.payments?.transactions ?? []).find((t) => t.payment_id)?.payment_id;
        if (!transactionId) throw new HttpError(409, "invoice_not_paid", "This invoice has no PayPal payment yet, so there is no transaction to attach tracking to.");
      }
      if (!transactionId) throw new HttpError(400, "invalid_input", "Give invoice_id or transaction_id");
      const proposal = deps.proposals.propose("add_invoice_tracking", `Add ${body.carrier} tracking ${body.tracking_number} to transaction ${transactionId}`, {
        trackers: [{ transaction_id: transactionId, tracking_number: body.tracking_number, status: "SHIPPED", ...carrierFor(body.carrier, "shipping"), notify_buyer: body.notify_buyer }],
      });
      ok(res, { proposal }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/disputes$/,
    handler: async ({ res, deps }) => {
      const list = await requirePayPal(deps).listDisputes({ page_size: 50 });
      ok(res, {
        disputes: (list.items ?? []).map((d) => ({
          dispute_id: d.dispute_id,
          reason: d.reason,
          status: d.status,
          dispute_state: d.dispute_state,
          stage: d.dispute_life_cycle_stage,
          amount: d.dispute_amount,
          create_time: d.create_time,
          seller_response_due_date: d.seller_response_due_date,
        })),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)$/,
    handler: async ({ res, deps, params }) => ok(res, await requirePayPal(deps).getDispute(params[0]!)),
  },
  {
    method: "POST",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)\/evidence-pack$/,
    ai: true,
    handler: async ({ req, res, deps, params }) => {
      const body = EvidenceRequestSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const paypal = requirePayPal(deps);
      const d = await paypal.getDispute(params[0]!);
      const tx = d.disputed_transactions?.[0];
      const inv = body.invoice_id ? await paypal.getInvoice(body.invoice_id) : undefined;
      const input: EvidenceInput = EvidenceInputSchema.parse({
        dispute: {
          dispute_id: d.dispute_id,
          reason: d.reason,
          status: d.status,
          dispute_life_cycle_stage: d.dispute_life_cycle_stage,
          amount: d.dispute_amount,
          create_time: d.create_time,
          seller_response_due_date: d.seller_response_due_date,
          transaction_id: tx?.seller_transaction_id,
        },
        ...(inv
          ? {
              invoice: {
                invoice_id: inv.id,
                invoice_number: inv.detail?.invoice_number,
                invoice_date: inv.detail?.invoice_date,
                status: inv.status,
                amount: inv.amount?.value ? { currency_code: inv.amount.currency_code ?? inv.detail.currency_code, value: inv.amount.value } : undefined,
                items: (inv.items ?? []).map((i) => ({ name: i.name, quantity: i.quantity, unit_amount: i.unit_amount })),
                paid_date: inv.payments?.transactions?.[0]?.payment_date,
              },
            }
          : {}),
        ...(body.tracking ? { tracking: body.tracking } : {}),
        messages: (d.messages ?? []).slice(-30).map((m) => ({ posted_by: m.posted_by, time_posted: m.time_posted, content: (m.content ?? "").slice(0, 2000) })),
        ...(body.seller_notes ? { seller_notes: body.seller_notes } : {}),
      });
      const pack = await deps.agent.disputeEvidencePack(input);
      const proposals = {
        provide_evidence: deps.proposals.propose("provide_dispute_evidence", `Provide evidence for dispute ${d.dispute_id}`, pack.evidence_payload),
        send_message: deps.proposals.propose("send_dispute_message", `Send reply to buyer in dispute ${d.dispute_id}`, pack.message_payload),
      };
      ok(res, { pack, proposals });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)\/accept-claim$/,
    handler: async ({ req, res, deps, params }) => {
      const body = z.object({ note: z.string().trim().min(1).max(2000) }).parse(await readJsonBody(req, MAX_API_BODY));
      requirePayPal(deps);
      ok(res, { proposal: deps.proposals.propose("accept_dispute_claim", `Accept claim and refund the buyer in dispute ${params[0]}`, { disputeId: params[0]!, note: body.note }) }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/proposals$/,
    handler: async ({ res, deps, query }) => {
      const status = z.enum(PROPOSAL_STATUSES as [ProposalStatus, ...ProposalStatus[]]).optional().catch(undefined).parse(query.get("status") ?? undefined) as ProposalStatus | undefined;
      ok(res, deps.proposals.list(status ? { status } : undefined));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]+)\/approve$/,
    handler: async ({ req, res, deps, params }) => {
      await readJsonBody(req, MAX_API_BODY); // body ignored: the stored payload is what runs
      if (deps.proposals.get(params[0]!)) requirePayPal(deps);
      const p = await deps.proposals.approve(params[0]!);
      ok(res, p);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]+)\/reject$/,
    handler: async ({ req, res, deps, params }) => {
      await readJsonBody(req, MAX_API_BODY);
      ok(res, deps.proposals.reject(params[0]!));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/events$/,
    handler: async ({ res, deps, query }) => {
      const category = z.enum(["invoice", "payment", "dispute", "ignored"]).optional().catch(undefined).parse(query.get("category") ?? undefined) as EventCategory | undefined;
      ok(res, deps.events.list(category ? { category } : undefined));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/demo\/seed$/,
    handler: async ({ req, res, deps }) => {
      await readJsonBody(req, MAX_API_BODY);
      requirePayPal(deps);
      const s = deps.settings;
      const listings = DEMO_ITEMS.map((d) => ({ title: d.seed.title, description: d.seed.description, price: { currency_code: "USD", value: d.seed.price_usd }, quantity: 1 }));
      let payload: SeedDemoDataPayload;
      if (s.paymentPath === "invoice") {
        if (s.demoBuyerEmails.length === 0) throw new HttpError(409, "no_demo_buyers", "Set DEMO_BUYER_EMAILS (sandbox personal account emails, comma-separated) to seed invoices.");
        payload = {
          invoices: listings.map((l, i) =>
            buildInvoicePayload(l, { email: s.demoBuyerEmails[i % s.demoBuyerEmails.length]! }, { subject: `Invoice: ${l.title}`, note: `Demo invoice for "${l.title}". Pay securely with PayPal (sandbox).` }, s.sellerBusinessName),
          ),
        };
      } else {
        payload = { orders: listings.map((l) => buildOrderPayload(l, { publicBaseUrl: s.publicBaseUrl, ...(s.sellerBusinessName ? { sellerBusinessName: s.sellerBusinessName } : {}) })) };
      }
      const count = (payload.invoices ?? payload.orders ?? []).length;
      ok(res, { proposal: deps.proposals.propose("seed_demo_data", `Seed ${count} sample ${s.paymentPath === "invoice" ? "invoices" : "payment links"} in the PayPal sandbox`, payload) }, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/chat$/,
    ai: true,
    handler: async ({ req, res, deps }) => {
      const body = ChatInputSchema.parse(await readJsonBody(req, MAX_API_BODY));
      ok(
        res,
        await chat(
          deps.ai,
          {
            paypal: deps.paypal,
            proposals: deps.proposals,
            agentConfig: { fxJpyPerUsd: deps.settings.fxJpyPerUsd, maxOutputTokens: deps.settings.aiMaxOutputTokens, publicBaseUrl: deps.settings.publicBaseUrl, ...(deps.settings.sellerBusinessName ? { sellerBusinessName: deps.settings.sellerBusinessName } : {}) },
            paymentPath: deps.settings.paymentPath,
          },
          body.messages,
          deps.settings.aiMaxOutputTokens,
        ),
      );
    },
  },
];

/** Handles /api/* requests. Returns false when no route matched the path. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps): Promise<boolean> {
  const matching = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (matching.length === 0) return false;
  const route = matching.find((r) => r.method === req.method);
  if (!route) throw new HttpError(405, "method_not_allowed", `Use ${matching.map((r) => r.method).join(" or ")}`, {}, { Allow: matching.map((r) => r.method).join(", ") });
  if (route.ai) {
    const verdict = deps.limiter.take(limitKey(clientAddress(req, deps.settings.trustProxyHops)));
    if (!verdict.ok) {
      throw new HttpError(429, verdict.reason === "per_ip" ? "rate_limited" : "daily_cap_reached", verdict.message, { retryAfterSeconds: verdict.retryAfterSeconds }, { "Retry-After": String(verdict.retryAfterSeconds) });
    }
  }
  const params = route.pattern.exec(url.pathname)!.slice(1);
  await route.handler({ req, res, params, query: url.searchParams, deps });
  return true;
}
