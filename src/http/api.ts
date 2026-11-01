import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { AiProvider } from "../ai/provider.js";
import { BuyerSchema, EvidenceInputSchema, JpItemSchema, ListingForSaleSchema, listingTotals, ShipmentFactsSchema, type EvidenceInput, type UnpaidInvoice } from "../agent/schemas.js";
import { Agent } from "../agent/tasks.js";
import { chat, ChatInputSchema } from "../agent/tools.js";
import type { AppSettings } from "../config.js";
import type { DemoBuyers } from "../demo/buyers.js";
import { DEMO_ITEMS } from "../demo/items.js";
import type { EventCategory, EventLog } from "../events/log.js";
import type { AiLimiter, LimitResult } from "../limits/rate-limit.js";
import { writeCost, type DemoLimits } from "../limits/demo-limits.js";
import type { PayPalReadCache } from "../paypal/read-cache.js";
import { showMoney } from "../money.js";
import { carrierFor } from "../paypal/carriers.js";
import { allowedActionList, disputeActions, sellerActionState } from "../paypal/dispute-actions.js";
import type { PayPalApi, OfflinePayPal } from "../paypal/offline.js";
import type { PayPalConfig } from "../paypal/config.js";
import type { Invoice } from "../paypal/types.js";
import type { SeedDemoDataPayload } from "../proposals/actions.js";
import { buildInvoicePayload, buildOrderPayload } from "../agent/tasks.js";
import type { OrderRegistry } from "../proposals/order-registry.js";
import type { ReminderLedger } from "../proposals/reminder-ledger.js";
import { PROPOSAL_STATUSES, ProposalError, type Proposal, type ProposalKind, type ProposalStatus, type ProposalStore } from "../proposals/store.js";
import { clientAddress, limitKey } from "./client-address.js";
import { disputeDetail, disputeRow, invoiceDetail, invoiceRow, orderView, publicPack, publicProposal as toPublic } from "./dto.js";
import { queueCapture } from "./paypal-return.js";
import { ensureSession, isSecureRequest } from "./session.js";
import { HttpError, isInvalidInputError, ok, readJsonBody } from "./util.js";
import { checkTrackingTarget } from "../journeys/created-here.js";
import { buildJourney, journeyCounts, saleFromInvoice } from "../journeys/journeys.js";
import type { OfflineWorlds } from "../journeys/offline-world.js";
import { recordExecution } from "../journeys/record.js";
import { COUNTRIES, isCountry, saleMarker, type Sale, type SaleRegistry } from "../journeys/sales.js";
import { knownDisputes, parseDisputeId, readAndRegister, saleOfDispute as linkedSale, type DisputeRegistry, type DisputeView } from "../journeys/disputes.js";
import { PayPalApiError } from "../paypal/client.js";

export interface ApiDeps {
  settings: AppSettings;
  paypalConfig: PayPalConfig | undefined;
  /** The real PayPal client (undefined without credentials or in the offline demo). */
  paypal: PayPalApi | undefined;
  /** Offline demo: one simulated PayPal per visitor (PAYPAL_OFFLINE_DEMO). */
  offline: OfflineWorlds | undefined;
  /** Sales (journeys) started on this server; also the tracking allowlist. */
  sales: SaleRegistry;
  /** Dispute ids known from PayPal's list, verified webhooks and reads by id (pass 3a). */
  disputes: DisputeRegistry;
  ai: AiProvider;
  /** Display info about the AI providers (primary and optional fallback). */
  aiInfo?: { primary: { provider: string; model: string | null }; fallback?: { provider: string; model: string | null } };
  /** AI credentials missing at startup (the server runs on with offline AI or no fallback). */
  aiWarnings?: { primary?: string; fallback?: string };
  agent: Agent;
  events: EventLog;
  proposals: ProposalStore;
  limiter: AiLimiter;
  /** Allowed recipients by alias (DEMO_BUYER_EMAILS). */
  buyers: DemoBuyers;
  /** Orders v2 ids created by this server, with the session that created them. */
  orders: OrderRegistry;
  /** At most 2 reminders per invoice per day. */
  reminders: ReminderLedger;
  /** Limits on proposals, approvals, PayPal reads/writes, seeding and execution (F2). */
  limits: DemoLimits;
  /** 30-second cache for PayPal list reads. */
  reads: PayPalReadCache;
}

/** Shown in the UI header: what a visitor can and cannot do on the public demo. */
export const DEMO_NOTICE = "Demo mode: you act as the seller of a shared PayPal sandbox account.";

const MAX_API_BODY = 64 * 1024;
const UNPAID = new Set(["SENT", "UNPAID", "PARTIALLY_PAID"]);
const ID = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _ only");

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
  query: URLSearchParams;
  deps: ApiDeps;
  /** Demo session of the caller (cookie). */
  session: string;
  /** Client address (see TRUST_PROXY_HOPS). */
  address: string;
  /** PayPal for this visitor: the shared sandbox client, or their offline simulator. */
  paypal: PayPalApi | undefined;
  /**
   * AI routes call this after validating their input and right before the first model call:
   * it debits the per-address AI allowance and checks the daily budget (F9).
   */
  startAi: () => void;
}

type Handler = (ctx: Ctx) => Promise<void>;

/** Public view of a proposal (recipients by alias, no owner). */
function publicProposal(ctx: Ctx, p: Proposal) {
  return toPublic(p, ctx.deps.buyers);
}

/** Creates a proposal owned by the caller's session. */
function propose<P>(ctx: Ctx, kind: ProposalKind, title: string, payload: P, copyForDm?: string, saleId?: string): Proposal<P> {
  const key = limitKey(ctx.address);
  ctx.deps.proposals.assertRoom(1, key);
  ctx.deps.limits.takeProposals(ctx.session, key);
  return ctx.deps.proposals.propose(kind, title, payload, { owner: ctx.session, address: limitKey(ctx.address), ...(copyForDm ? { copyForDm } : {}), ...(saleId ? { saleId } : {}) });
}

/** The caller's sale, if it may still be billed (draft, no invoice or order yet). */
function ownDraftSale(ctx: Ctx, saleId: string | undefined): Sale | undefined {
  if (!saleId) return undefined;
  const sale = ctx.deps.sales.get(saleId);
  return sale && sale.owner === ctx.session && !sale.invoiceId && !sale.orderId ? sale : undefined;
}

/** The sale a dispute belongs to (invoice transaction id, order capture id or invoice number). */
function saleOfDispute(deps: ApiDeps, d: { disputed_transactions?: Array<{ seller_transaction_id?: string; invoice_number?: string }> }): Sale | undefined {
  return linkedSale(deps.sales, d);
}

function discoveryDeps(deps: ApiDeps) {
  return { reads: deps.reads, disputes: deps.disputes, offline: Boolean(deps.offline) };
}

/** A warning line for a PayPal read that failed (with PayPal's debug_id when there is one). */
function readWarning(err: unknown, what: string): string {
  return err instanceof Error && "debugId" in err ? `${what} could not be read (debug_id ${(err as { debugId?: string }).debugId ?? "-"}); showing what this app knows.` : `${what} could not be read; showing what this app knows.`;
}

/** A row of the dispute list, with where the app learned about it and the linked sale. */
function knownDisputeRow(deps: ApiDeps, v: DisputeView) {
  const sale = saleOfDispute(deps, v.dispute);
  return { ...disputeRow(v.dispute), in_paypal_list: v.inList, sources: v.sources, ...(sale ? { sale_id: sale.id } : {}) };
}

/** Resolves a buyer alias, or explains which aliases exist. */
function requireBuyer(deps: ApiDeps, alias: string | undefined): string {
  if (deps.buyers.size === 0) {
    throw new HttpError(409, "no_demo_buyers", "No demo buyers are configured. Set DEMO_BUYER_EMAILS (sandbox personal account emails, comma-separated) to send invoices or payment links.");
  }
  const buyer = alias ? deps.buyers.resolve(alias) : undefined;
  if (!buyer) throw new HttpError(400, "unknown_buyer", `Choose one of the demo buyers: ${deps.buyers.aliases.join(", ")}`, { buyers: deps.buyers.aliases });
  return buyer.alias;
}

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  /** AI routes are rate limited and count toward the daily cap. */
  ai?: boolean;
  /** Routes that read from PayPal count toward the per-address read limit. */
  paypalRead?: boolean;
  handler: Handler;
}

function requirePayPal(ctx: Ctx): PayPalApi {
  if (!ctx.paypal) {
    throw new HttpError(503, "paypal_not_configured", "PayPal is not configured on this server. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) to use this feature.");
  }
  return ctx.paypal;
}

function requireOffline(ctx: Ctx): OfflinePayPal {
  if (!ctx.deps.offline || !ctx.paypal) throw new HttpError(404, "not_found", "Simulated buyer actions exist only in the offline demo (PAYPAL_OFFLINE_DEMO=true).");
  return ctx.paypal as OfflinePayPal;
}

function bannerMessages(deps: ApiDeps): string[] {
  const out: string[] = [];
  if (deps.offline) out.push("Offline demo: PayPal is simulated in memory for your browser only. Nothing is sent to PayPal or to anyone. Use the Simulate buttons to act as the buyer.");
  else if (!deps.paypal) out.push("PayPal is not configured: invoices, shipments and disputes are disabled. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) and restart.");
  if (deps.aiWarnings?.primary) out.push(`AI is not configured: ${deps.aiWarnings.primary} Set the key and restart.`);
  else if (deps.ai.name === "fake") out.push("AI runs in offline demo mode (AI_PROVIDER=fake): answers are rule-based, not from a real model.");
  if (deps.paypal && !deps.paypalConfig?.webhookId) out.push("PAYPAL_WEBHOOK_ID is not set: webhook events cannot be verified, so the event log stays empty.");
  return out;
}

export function healthData(deps: ApiDeps) {
  return {
    app: "okuri",
    paypal: {
      configured: Boolean(deps.paypal || deps.offline),
      env: deps.offline ? "sandbox" : (deps.paypalConfig?.env ?? null),
      offline: Boolean(deps.offline),
      webhookConfigured: Boolean(deps.paypalConfig?.webhookId),
    },
    ai: {
      provider: deps.aiInfo?.primary.provider ?? deps.ai.name,
      model: deps.aiInfo?.primary.model ?? deps.ai.model ?? null,
      ...(deps.aiInfo?.fallback ? { fallback: deps.aiInfo.fallback } : {}),
      // Present only when a credential was missing at startup.
      ...(deps.aiWarnings?.primary ? { configured: false } : {}),
      ...(deps.aiWarnings ? { warnings: [deps.aiWarnings.primary, deps.aiWarnings.fallback].filter((w): w is string => Boolean(w)) } : {}),
    },
    countries: Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })),
    paymentPath: deps.settings.paymentPath,
    fxJpyPerUsd: deps.settings.fxJpyPerUsd,
    demoLimits: {
      windowMinutes: deps.settings.rateLimitWindowMinutes,
      proposals: deps.settings.proposalRateLimit,
      approvals: deps.settings.approvalRateLimit,
      paypalReads: deps.settings.paypalReadRateLimit,
      paypalWritesToday: deps.limits.writesToday.used(),
      paypalDailyWriteCap: deps.settings.paypalDailyWriteCap,
    },
    limits: {
      perIp: deps.settings.aiRateLimitPerIp,
      windowMinutes: deps.settings.aiRateLimitWindowMinutes,
      dailyCap: deps.settings.aiDailyCap,
      maxOutputTokens: deps.settings.aiMaxOutputTokens,
      usedToday: deps.limiter.usage().usedToday,
      ...(deps.limiter.usage().fallback ? { fallback: deps.limiter.usage().fallback } : {}),
      invalidPerIp: deps.settings.aiInvalidRateLimitPerIp,
      countsModelCalls: true,
    },
    demo: { notice: DEMO_NOTICE, buyerEmailsConfigured: deps.buyers.size, buyers: deps.buyers.publicList() },
    // AG Studio runs in the browser, so its licence key has to reach the browser (like AG Grid keys).
    agStudio: { licensed: deps.settings.agStudioLicensed, ...(deps.settings.agStudioLicenseKey ? { licenseKey: deps.settings.agStudioLicenseKey } : {}) },
    banner: bannerMessages(deps),
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

const PrepareSchema = z.object({
  listing: ListingForSaleSchema,
  buyer: BuyerSchema.optional(),
  /** Continue this draft journey (otherwise a new one starts). */
  sale_id: z.string().max(20).optional(),
  country: z.string().refine(isCountry, "unknown country code").optional(),
  title_ja: z.string().max(200).optional(),
});

/** The sale to bill: the caller's draft, or a new one. Updated with what is billed now. */
function saleToBill(ctx: Ctx, body: z.infer<typeof PrepareSchema>, alias: string, path: "invoice" | "order"): Sale {
  const draft = ownDraftSale(ctx, body.sale_id);
  // The sale's amount is what the buyer is billed: item total plus shipping (pass 4).
  const t = listingTotals(body.listing);
  const fields = { titleEn: body.listing.title, listing: body.listing, buyerAlias: alias, amount: { currency_code: t.currency_code, value: t.total }, path };
  if (draft) {
    Object.assign(draft, fields, body.country ? { country: body.country } : {});
    return draft;
  }
  const sale = ctx.deps.sales.create({ owner: ctx.session, ...fields, ...(body.title_ja ? { titleJa: body.title_ja } : {}), country: body.country ?? "US" });
  ctx.deps.sales.note(sale, "Item added");
  return sale;
}

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
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const { item, country } = z.object({ item: JpItemSchema, country: z.string().refine(isCountry, "unknown country code").optional() }).parse(await readJsonBody(req, MAX_API_BODY));
      ctx.startAi();
      const listing = await deps.agent.draftListing(item);
      // Every draft starts a journey (private to this visitor until PayPal holds an invoice).
      const sale = deps.sales.create({
        owner: ctx.session,
        titleJa: item.title_ja,
        titleEn: listing.title.slice(0, 127),
        listing: { title: listing.title.slice(0, 127), description: listing.description.slice(0, 1000), price: { currency_code: "USD", value: listing.price.usd }, quantity: 1 },
        buyerAlias: "",
        country: country ?? "US",
        amount: { currency_code: "USD", value: listing.price.usd },
        path: deps.settings.paymentPath,
        draftedBy: listing.generated_by,
      });
      deps.sales.note(sale, "Item added (Japanese)");
      deps.sales.note(sale, "English draft prepared");
      ok(res, { ...listing, sale_id: sale.id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/invoices\/prepare$/,
    ai: true,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = PrepareSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const alias = requireBuyer(deps, body.buyer?.alias);
      deps.proposals.assertRoom(1, limitKey(ctx.address));
      deps.limits.checkProposals(ctx.session, limitKey(ctx.address));
      ctx.startAi();
      const path = deps.settings.paymentPath;
      const sale = saleToBill(ctx, body, alias, path);
      const marker = saleMarker(sale.id, sale.country);
      if (path === "order") {
        const prepared = await deps.agent.preparePaymentLink(body.listing, { alias }, marker);
        const proposal = propose(ctx, "create_payment_link", `Create payment link for ${showMoney(body.listing.price)} for ${alias}: ${body.listing.title}`, prepared.payload, prepared.buyer_message.note, sale.id);
        deps.sales.note(sale, "Payment link prepared, awaiting your approval");
        return ok(res, { path: "order", sale_id: sale.id, proposal: publicProposal(ctx, proposal), buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
      }
      const prepared = await deps.agent.prepareInvoice(body.listing, { alias }, marker);
      const proposal = propose(ctx, "create_and_send_invoice", `Send invoice for ${showMoney(body.listing.price)} to ${alias}: ${body.listing.title}`, prepared.payload, undefined, sale.id);
      deps.sales.note(sale, "Invoice prepared, awaiting your approval");
      ok(res, { path: "invoice", sale_id: sale.id, proposal: publicProposal(ctx, proposal), buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/payment-links\/prepare$/,
    ai: true,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = PrepareSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const alias = requireBuyer(deps, body.buyer?.alias);
      deps.proposals.assertRoom(1, limitKey(ctx.address));
      deps.limits.checkProposals(ctx.session, limitKey(ctx.address));
      ctx.startAi();
      const sale = saleToBill(ctx, body, alias, "order");
      const prepared = await deps.agent.preparePaymentLink(body.listing, { alias }, saleMarker(sale.id, sale.country));
      const proposal = propose(ctx, "create_payment_link", `Create payment link for ${showMoney(body.listing.price)} for ${alias}: ${body.listing.title}`, prepared.payload, prepared.buyer_message.note, sale.id);
      deps.sales.note(sale, "Payment link prepared, awaiting your approval");
      ok(res, { path: "order", sale_id: sale.id, proposal: publicProposal(ctx, proposal), buyer_message: prepared.buyer_message, generated_by: prepared.generated_by });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/invoices$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { res, deps, query } = ctx;
      const page = z.coerce.number().int().min(1).max(1000).catch(1).parse(query.get("page") ?? 1);
      const list = await deps.reads.listInvoices(requirePayPal(ctx), { page, page_size: 20, total_required: true });
      ok(res, { total_items: list.total_items ?? null, total_pages: list.total_pages ?? null, page, invoices: (list.items ?? []).map((inv) => invoiceRow(inv, deps.buyers)) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/invoices\/nudge$/,
    ai: true,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = z.object({ invoice_ids: z.array(ID).max(20).optional() }).parse(await readJsonBody(req, MAX_API_BODY));
      deps.limits.checkProposals(ctx.session, limitKey(ctx.address));
      const list = await deps.reads.listInvoices(requirePayPal(ctx), { page: 1, page_size: 50 });
      const wanted = body.invoice_ids ? new Set(body.invoice_ids) : undefined;
      const now = Date.now();
      const candidates = (list.items ?? []).filter((inv) => inv.status && UNPAID.has(inv.status) && (!wanted || wanted.has(inv.id)));
      // PayPal allows 2 reminders per invoice per day: skip invoices that already had them.
      const skipped = candidates.filter((inv) => deps.reminders.remaining(inv.id) <= 0).map((inv) => ({ invoice_id: inv.id, reason: "already reminded twice today (PayPal's daily limit)" }));
      const unpaid: UnpaidInvoice[] = candidates
        .filter((inv) => deps.reminders.remaining(inv.id) > 0)
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
      if (unpaid.length) {
        deps.proposals.assertRoom(unpaid.length, limitKey(ctx.address));
        deps.limits.checkProposals(ctx.session, limitKey(ctx.address), unpaid.length);
        ctx.startAi();
      }
      const numbers = new Map(unpaid.map((u) => [u.invoice_id, u.invoice_number]));
      const proposals = reminders.map((r) =>
        propose(ctx, "send_invoice_reminder", `Send PayPal's standard reminder for invoice ${numbers.get(r.invoice_id) ?? r.invoice_id}`, r.payload, r.copy_for_dm, deps.sales.byInvoice(r.invoice_id)?.id),
      );
      ok(res, { unpaid_count: unpaid.length, proposals: proposals.map((p) => publicProposal(ctx, p)), skipped, generated_by });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/invoices\/([A-Za-z0-9_-]+)$/,
    paypalRead: true,
    handler: async (ctx) => ok(ctx.res, invoiceDetail(await requirePayPal(ctx).getInvoice(ctx.params[0]!), ctx.deps.buyers)),
  },
  {
    method: "GET",
    pattern: /^\/api\/orders\/([A-Za-z0-9_-]+)$/,
    paypalRead: true,
    handler: async (ctx) => ok(ctx.res, orderView(await requirePayPal(ctx).getOrder(ctx.params[0]!))),
  },
  {
    method: "POST",
    pattern: /^\/api\/orders\/([A-Za-z0-9_-]+)\/capture$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps, params } = ctx;
      await readJsonBody(req, MAX_API_BODY);
      const paypal = requirePayPal(ctx);
      const orderId = params[0]!;
      const known = deps.orders.get(orderId);
      if (!known || known.owner !== ctx.session) {
        throw new HttpError(404, "order_not_found", "Only payment links created in your demo session can be captured here.");
      }
      const order = await paypal.getOrder(orderId);
      if (order.status !== "APPROVED") throw new HttpError(409, "order_not_approved", `PayPal reports this order as ${order.status}; it can be captured only after the buyer approves it.`);
      const proposal = queueCapture(deps, orderId)!;
      ok(res, { proposal: publicProposal(ctx, proposal) }, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tracking$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = TrackingSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const paypal = requirePayPal(ctx);
      // Only invoices and orders this demo created (registry or marker in the PayPal record).
      if (body.kind === "order") {
        const check = await checkTrackingTarget(deps, paypal, { kind: "order", order_id: body.order_id });
        const proposal = propose(
          ctx,
          "add_order_tracking",
          `Add ${body.carrier} tracking ${body.tracking_number} to ${check.saleId ?? `order ${body.order_id}`}`,
          {
            orderId: body.order_id,
            tracker: { capture_id: body.capture_id, tracking_number: body.tracking_number, ...carrierFor(body.carrier, "orders"), notify_payer: body.notify_buyer },
          },
          undefined,
          check.saleId,
        );
        deps.sales.note(check.saleId ? deps.sales.get(check.saleId) : undefined, "Tracking number entered, awaiting your approval");
        return ok(res, { proposal: publicProposal(ctx, proposal) }, 201);
      }
      const check = await checkTrackingTarget(deps, paypal, { kind: "invoice", ...(body.invoice_id ? { invoice_id: body.invoice_id } : {}), ...(body.transaction_id ? { transaction_id: body.transaction_id } : {}) });
      const transactionId = check.transactionId!;
      const proposal = propose(
        ctx,
        "add_invoice_tracking",
        `Add ${body.carrier} tracking ${body.tracking_number} to ${check.saleId ?? `transaction ${transactionId}`}`,
        { trackers: [{ transaction_id: transactionId, tracking_number: body.tracking_number, status: "SHIPPED", ...carrierFor(body.carrier, "shipping"), notify_buyer: body.notify_buyer }] },
        undefined,
        check.saleId,
      );
      deps.sales.note(check.saleId ? deps.sales.get(check.saleId) : undefined, "Tracking number entered, awaiting your approval");
      ok(res, { proposal: publicProposal(ctx, proposal) }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/disputes$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { res, deps } = ctx;
      // PayPal's list can lag behind new cases by minutes: add the ones known from webhooks or by id.
      const { items, listError } = await knownDisputes(discoveryDeps(deps), requirePayPal(ctx));
      if (listError !== undefined && items.length === 0) throw listError;
      ok(res, { disputes: items.map((v) => knownDisputeRow(deps, v)), warnings: listError !== undefined ? [readWarning(listError, "PayPal's dispute list")] : [] });
    },
  },
  {
    // "Open a case by ID": new sandbox cases can take minutes to appear in PayPal's list, but
    // they can be read by id at once. Reads the case and registers it for every page.
    method: "POST",
    pattern: /^\/api\/disputes\/open$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = z.object({ dispute_id: z.string().max(200) }).parse(await readJsonBody(req, MAX_API_BODY));
      const id = parseDisputeId(body.dispute_id);
      if (!id) throw new HttpError(400, "invalid_dispute_id", "Paste the case ID as PayPal shows it, for example PP-R-ABC-12345678 or PP-D-12345.");
      const paypal = requirePayPal(ctx);
      deps.limits.takeDisputeLookup(ctx.session, limitKey(ctx.address));
      let d;
      try {
        d = await readAndRegister(discoveryDeps(deps), paypal, id, "by_id");
      } catch (err) {
        if (err instanceof PayPalApiError && (err.status === 404 || err.status === 403)) {
          throw new HttpError(404, "dispute_not_found", `PayPal has no case ${id} for this demo's sandbox seller account. Check the ID: it has to be a case opened against a payment to this seller.`, {
            paypal: { status: err.status, ...(err.errorName ? { name: err.errorName } : {}), ...(err.debugId ? { debugId: err.debugId } : {}) },
          });
        }
        throw err;
      }
      const sale = saleOfDispute(deps, d);
      const entry = deps.disputes.get(d.dispute_id);
      ok(res, { ...disputeDetail(d), ...(sale ? { sale_id: sale.id } : {}), ...(entry ? { sources: entry.sources } : {}) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)$/,
    paypalRead: true,
    handler: async (ctx) => {
      const d = await readAndRegister(discoveryDeps(ctx.deps), requirePayPal(ctx), ctx.params[0]!, "by_id");
      const sale = saleOfDispute(ctx.deps, d);
      ok(ctx.res, { ...disputeDetail(d), ...(sale ? { sale_id: sale.id } : {}) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)\/evidence-pack$/,
    ai: true,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps, params } = ctx;
      const body = EvidenceRequestSchema.parse(await readJsonBody(req, MAX_API_BODY));
      const paypal = requirePayPal(ctx);
      deps.limits.checkProposals(ctx.session, limitKey(ctx.address), 2);
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
          allowed_actions: allowedActionList(d),
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
      ctx.startAi();
      const pack = await deps.agent.disputeEvidencePack(input);
      // Only actions PayPal currently allows on this dispute become proposals (F11).
      const allowed = disputeActions(d);
      const saleId = saleOfDispute(deps, d)?.id;
      const proposals = {
        ...(allowed.provide_evidence.allowed
          ? { provide_evidence: publicProposal(ctx, propose(ctx, "provide_dispute_evidence", `Provide evidence for dispute ${d.dispute_id}`, pack.evidence_payload, undefined, saleId)) }
          : {}),
        ...(allowed.send_message.allowed ? { send_message: publicProposal(ctx, propose(ctx, "send_dispute_message", `Send reply to buyer in dispute ${d.dispute_id}`, pack.message_payload, undefined, saleId)) } : {}),
      };
      // No seller action at PayPal: the pack and the reply draft are still returned, read-only.
      ok(res, { pack: publicPack(pack), proposals, allowed_actions: allowed, ...sellerActionState(d) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/disputes\/([A-Za-z0-9_-]+)\/accept-claim$/,
    paypalRead: true,
    handler: async (ctx) => {
      const { req, res, deps, params } = ctx;
      const body = z.object({ note: z.string().trim().min(1).max(2000) }).parse(await readJsonBody(req, MAX_API_BODY));
      const dispute = await requirePayPal(ctx).getDispute(params[0]!);
      const verdict = disputeActions(dispute).accept_claim;
      if (!verdict.allowed) throw new HttpError(409, "action_not_allowed", verdict.reason);
      ok(res, { proposal: publicProposal(ctx, propose(ctx, "accept_dispute_claim", `Accept claim and refund the buyer in dispute ${params[0]}`, { disputeId: params[0]!, note: body.note }, undefined, saleOfDispute(deps, dispute)?.id)) }, 201);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/proposals$/,
    handler: async (ctx) => {
      const { res, deps, query, session } = ctx;
      const status = z.enum(PROPOSAL_STATUSES as [ProposalStatus, ...ProposalStatus[]]).optional().catch(undefined).parse(query.get("status") ?? undefined) as ProposalStatus | undefined;
      ok(res, deps.proposals.list({ owner: session, ...(status ? { status } : {}) }).map((p) => publicProposal(ctx, p)));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]+)\/approve$/,
    handler: async (ctx) => {
      const { req, res, deps, params, session } = ctx;
      await readJsonBody(req, MAX_API_BODY); // body ignored: the stored payload is what runs
      const found = deps.proposals.get(params[0]!, session);
      if (!found) throw new ProposalError(`proposal ${params[0]} not found`, "not_found");
      if (found.status !== "pending") throw new ProposalError(`proposal ${found.id} is ${found.status}, not pending`, "not_pending");
      requirePayPal(ctx);
      const key = limitKey(ctx.address);
      // All checks before the first await, so they hold for this execution (F2).
      deps.limits.checkApproval(session, key);
      if (found.kind === "seed_demo_data") deps.limits.checkSeed(session);
      const release = deps.limits.acquireExecution();
      try {
        const writes = writeCost(found.kind, found.payload);
        deps.limits.reserveWrites(writes);
        deps.limits.takeApproval(session, key);
        if (found.kind === "seed_demo_data") deps.limits.takeSeed(session);
        const p = await deps.proposals.approve(found.id, session);
        if (p.status === "obsolete") deps.limits.refundWrites(writes); // nothing was written
        if (p.status !== "obsolete") deps.reads.invalidate();
        recordExecution(deps.sales, p);
        ok(res, publicProposal(ctx, p));
      } finally {
        release();
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/proposals\/([A-Za-z0-9_-]+)\/reject$/,
    handler: async (ctx) => {
      const { req, res, deps, params, session } = ctx;
      await readJsonBody(req, MAX_API_BODY);
      ok(res, publicProposal(ctx, deps.proposals.reject(params[0]!, session)));
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
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      await readJsonBody(req, MAX_API_BODY);
      requirePayPal(ctx);
      requireBuyer(deps, deps.buyers.aliases[0]);
      deps.limits.checkSeed(ctx.session);
      const s = deps.settings;
      const listings = DEMO_ITEMS.map((d) => ({ title: d.seed.title, description: d.seed.description, price: { currency_code: "USD", value: d.seed.price_usd }, quantity: 1 }));
      const seedCountries = ["US", "GB", "AU", "CA"];
      // Each sample becomes a journey; the marker ties the PayPal record to it.
      const sales = listings.map((l, i) => {
        const sale = deps.sales.create({ owner: ctx.session, titleJa: DEMO_ITEMS[i]!.item.title_ja, titleEn: l.title, listing: l, buyerAlias: deps.buyers.at(i).alias, country: seedCountries[i % seedCountries.length]!, amount: l.price, path: s.paymentPath });
        deps.sales.note(sale, "Sample item added (Seed demo data)");
        return sale;
      });
      const markerOf = (i: number) => saleMarker(sales[i]!.id, sales[i]!.country);
      let payload: SeedDemoDataPayload;
      if (s.paymentPath === "invoice") {
        payload = {
          invoices: listings.map((l, i) =>
            buildInvoicePayload(l, deps.buyers.at(i).alias, { note: `Demo invoice for "${l.title}". Pay securely with PayPal (sandbox).` }, s.sellerBusinessName, markerOf(i)),
          ),
        };
      } else {
        payload = { orders: listings.map((l, i) => buildOrderPayload(l, deps.buyers.at(i).alias, { publicBaseUrl: s.publicBaseUrl, ...(s.sellerBusinessName ? { sellerBusinessName: s.sellerBusinessName } : {}) }, markerOf(i))) };
      }
      const count = (payload.invoices ?? payload.orders ?? []).length;
      ok(res, { proposal: publicProposal(ctx, propose(ctx, "seed_demo_data", `Seed ${count} sample ${s.paymentPath === "invoice" ? "invoices" : "payment links"} for the demo buyers in the PayPal sandbox`, payload)) }, 201);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/chat$/,
    ai: true,
    handler: async (ctx) => {
      const { req, res, deps, session } = ctx;
      const body = ChatInputSchema.parse(await readJsonBody(req, MAX_API_BODY));
      ctx.startAi();
      const result = await chat(
        deps.ai,
        {
          paypal: ctx.paypal,
          proposals: deps.proposals,
          trackable: (target) => checkTrackingTarget(deps, requirePayPal(ctx), target),
          agentConfig: { fxJpyPerUsd: deps.settings.fxJpyPerUsd, maxOutputTokens: deps.settings.aiMaxOutputTokens, publicBaseUrl: deps.settings.publicBaseUrl, ...(deps.settings.sellerBusinessName ? { sellerBusinessName: deps.settings.sellerBusinessName } : {}) },
          paymentPath: deps.settings.paymentPath,
          sessionId: session,
          address: limitKey(ctx.address),
          buyers: deps.buyers,
          reminders: deps.reminders,
          reads: deps.reads,
          beforePropose: () => deps.limits.takeProposals(session, limitKey(ctx.address)),
          beforeRead: () => deps.limits.takeRead(limitKey(ctx.address)),
        },
        body.messages,
        deps.settings.aiMaxOutputTokens,
      );
      ok(res, { ...result, proposals: result.proposals.map((p) => publicProposal(ctx, p)) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/journeys$/,
    paypalRead: true,
    handler: async (ctx) => ok(ctx.res, await journeysFor(ctx)),
  },
  {
    method: "POST",
    pattern: /^\/api\/offline\/simulate$/,
    handler: async (ctx) => {
      const { req, res, deps } = ctx;
      const body = z.object({ sale_id: z.string().max(20), action: z.enum(["payment", "dispute", "delivery"]) }).parse(await readJsonBody(req, MAX_API_BODY));
      const paypal = requireOffline(ctx);
      const sale = deps.sales.get(body.sale_id);
      if (!sale || sale.owner !== ctx.session) throw new HttpError(404, "sale_not_found", "No such sale in your offline demo.");
      const now = new Date().toISOString();
      try {
        if (body.action === "payment") {
          if (sale.invoiceId) {
            sale.transactionId = paypal.simulateInvoicePayment(sale.invoiceId);
            sale.paidAt = now;
            deps.sales.note(sale, "Buyer paid the invoice through PayPal (simulated)", now);
          } else if (sale.orderId) {
            paypal.simulateOrderApproval(sale.orderId);
            const capture = queueCapture(deps, sale.orderId);
            if (capture) capture.saleId = sale.id;
            deps.sales.note(sale, "Buyer approved the payment link (simulated); capture awaits your approval", now);
          } else throw new HttpError(409, "not_billed", "Send the invoice first.");
        } else if (body.action === "dispute") {
          if (!sale.invoiceId || !sale.transactionId) throw new HttpError(409, "not_paid", "A buyer can open a dispute only after paying.");
          paypal.simulateDispute(sale.invoiceId);
        } else {
          if (!sale.tracking) throw new HttpError(409, "not_shipped", "Add tracking first.");
          sale.deliveredAt = now;
          deps.sales.note(sale, "Delivered (simulated)", now);
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(409, "simulation_refused", err instanceof Error ? err.message : String(err));
      }
      ok(res, { sale_id: sale.id, action: body.action });
    },
  },
];

/** Journeys the caller may see, with counts. Reads invoices and disputes once (cached). */
async function journeysFor(ctx: Ctx) {
  const { deps } = ctx;
  const paypal = ctx.paypal;
  let invoices: Map<string, Invoice> = new Map();
  let disputes: DisputeView[] = [];
  const warnings: string[] = [];
  if (paypal) {
    try {
      const list = await deps.reads.listInvoices(paypal, { page: 1, page_size: 50 });
      invoices = new Map((list.items ?? []).map((inv) => [inv.id, inv]));
      // After a restart: recognise this app's invoices by their marker and rebuild the journey.
      if (!deps.offline) for (const inv of list.items ?? []) if (!deps.sales.byInvoice(inv.id)) { const rebuilt = saleFromInvoice(inv, deps.buyers); if (rebuilt) deps.sales.adopt(rebuilt); }
      const known = await knownDisputes(discoveryDeps(deps), paypal);
      disputes = known.items;
      if (known.listError !== undefined) warnings.push(readWarning(known.listError, "PayPal's dispute list"));
    } catch (err) {
      warnings.push(readWarning(err, "PayPal"));
    }
  }
  const sales = deps.sales.visibleTo(ctx.session, Boolean(deps.offline)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const proposals = deps.proposals.list({ owner: ctx.session });
  const jctx = { sales, invoices, disputes, proposals, offline: Boolean(deps.offline), buyers: deps.buyers, registry: deps.sales };
  const journeys = sales.map((sale) => buildJourney(sale, jctx));
  return { journeys, counts: journeyCounts(journeys), pending_count: proposals.filter((p) => p.status === "pending").length, warnings };
}

/** Handles /api/* requests. Returns false when no route matched the path. */
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps): Promise<boolean> {
  const matching = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (matching.length === 0) return false;
  const route = matching.find((r) => r.method === req.method);
  if (!route) throw new HttpError(405, "method_not_allowed", `Use ${matching.map((r) => r.method).join(" or ")}`, {}, { Allow: matching.map((r) => r.method).join(", ") });
  const address = clientAddress(req, deps.settings.trustProxyHops);
  const session = ensureSession(req, res, isSecureRequest(req, deps.settings.publicBaseUrl, deps.settings.trustProxyHops));
  const key = limitKey(address);
  const refuse = (v: Exclude<LimitResult, { ok: true }>) =>
    new HttpError(429, { per_ip: "rate_limited", daily_cap: "daily_cap_reached", invalid: "too_many_invalid_requests" }[v.reason], v.message, { retryAfterSeconds: v.retryAfterSeconds }, { "Retry-After": String(v.retryAfterSeconds) });
  if (route.ai) {
    // Cheap check for addresses that keep sending invalid AI requests (before parsing).
    const v = deps.limiter.checkInvalid(key);
    if (!v.ok) throw refuse(v);
  }
  if (route.paypalRead && deps.paypal) deps.limits.takeRead(key);
  // Offline demo: the visitor's simulated PayPal (seeded on first use).
  const paypal = deps.offline ? await deps.offline.get(session, key) : deps.paypal;
  let aiStarted = false;
  const startAi = () => {
    if (aiStarted) return;
    aiStarted = true;
    const v = deps.limiter.take(key);
    if (!v.ok) throw refuse(v);
  };
  const params = route.pattern.exec(url.pathname)!.slice(1);
  try {
    await route.handler({ req, res, params, query: url.searchParams, deps, session, address, startAi, paypal });
  } catch (err) {
    if (route.ai && !aiStarted && isInvalidInputError(err)) deps.limiter.recordInvalid(key);
    throw err;
  }
  return true;
}
