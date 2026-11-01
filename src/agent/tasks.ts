import { renderTextPdf } from "../docs/simple-pdf.js";
import type { AiProvider } from "../ai/provider.js";
import { usdFromJpy } from "../money.js";
import { carrierFor } from "../paypal/carriers.js";
import type { CreateOrderRequest, DisputeEvidence, InvoiceDraft } from "../paypal/types.js";
import type {
  CreateAndSendInvoicePayload,
  CreatePaymentLinkPayload,
  EvidenceAttachment,
  ProvideEvidencePayload,
  SendDisputeMessagePayload,
  SendReminderPayload,
} from "../proposals/actions.js";
import { unsupportedFacts } from "./fact-check.js";
import { AgentOutputError, runJsonTask } from "./json-task.js";
import { repairSendableText } from "./sendable-text.js";
import {
  BuyerMessageAiSchema,
  EvidencePackAiSchema,
  ListingAiSchema,
  listingTotals,
  NudgeAiSchema,
  type Buyer,
  type EvidenceInput,
  type EvidencePackAi,
  type JpItem,
  type ListingAi,
  type ListingForSale,
  type UnpaidInvoice,
} from "./schemas.js";

export interface AgentConfig {
  /** JPY per 1 USD for the price estimate (FX_JPY_PER_USD, default 150). */
  fxJpyPerUsd: number;
  /** Per-call output cap (AI_MAX_OUTPUT_TOKENS). */
  maxOutputTokens: number;
  /** Shown on invoices and checkout pages (SELLER_BUSINESS_NAME). */
  sellerBusinessName?: string;
  /** Base URL of this app; used for Orders v2 return/cancel URLs (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
}

export interface GeneratedBy {
  provider: string;
  model?: string;
  /** The primary provider that could not answer, when the fallback did (AI_FALLBACK_PROVIDER). */
  fallback_from?: { provider: string; model?: string; reason: string };
}

export interface Listing extends ListingAi {
  source: JpItem;
  price: { jpy: number; usd: string; fx_jpy_per_usd: number; is_estimate: true; note: string };
  hs_code: { candidate: string; label: "check before use" };
  generated_by: GeneratedBy;
}

export interface PreparedBilling<P> {
  payload: P;
  /** Invoice path: the invoice note (shown to the buyer by PayPal). Order path: a DM text. */
  buyer_message: { note: string };
  generated_by: GeneratedBy;
}

export interface PreparedReminder {
  invoice_id: string;
  /** PayPal's standard reminder (flags only). */
  payload: SendReminderPayload;
  /** AI-written friendly text for the seller to send by DM. Not sent to PayPal. */
  copy_for_dm: string;
}

export interface EvidencePack extends EvidencePackAi {
  /** Concrete facts in the AI text that are not in the inputs. Non-empty means: do not send as is. */
  unverified_facts: string[];
  attachments: Array<{ name: string; contentType: string; description: string }>;
  evidence_payload: ProvideEvidencePayload;
  message_payload: SendDisputeMessagePayload;
  generated_by: GeneratedBy;
}

const LISTING_SYSTEM = `You are the listing assistant of Okuri, an export desk for small Japanese sellers.
Translate and adapt the seller's Japanese item into an English marketplace listing for overseas buyers.
Rules:
- Use only facts present in the input. Do not invent brand, age, size, material or provenance. If a detail is unknown, leave it out.
- title: max 80 characters, plain, no emojis or ALL CAPS.
- description: honest, warm, 2-5 short paragraphs; mention condition as given.
- item_specifics: short name/value pairs taken from the input (e.g. Condition, Material, Origin: Japan).
- customs_description: a plain English description a customs officer understands (what it is and what it is made of), max 120 characters, no marketing words.
- hs_code_candidate: a 6-digit Harmonized System code candidate written like 6912.00, or "" if unsure. It is only a hint; the seller will verify it.
- Do not output prices; the app calculates them.`;

const BILLING_SYSTEM = `You write the short note a small Japanese seller includes with a PayPal payment request to an overseas buyer.
Write friendly, clear English. Mention the item and that payment is handled securely by PayPal.
Do not invent shipping dates, discounts, tracking numbers or promises. Max 1000 characters for note.
When the input has shipping and total, the buyer pays the total (item price plus shipping). If you mention an amount, state the total; you may add the item price and the shipping, but never call the item price "the price" or "the total". Use only amounts from the input.`;

const NUDGE_SYSTEM = `You write short, friendly payment reminder messages that a small Japanese seller sends to overseas buyers by social media direct message (DM).
PayPal separately sends its own standard reminder email, so the DM can say that the buyer may also get a reminder from PayPal.
One message per input invoice, using the same invoice_id. Be friendly and brief; never threaten, never add fees or deadlines that are not in the input.`;

const EVIDENCE_SYSTEM = `You help a small Japanese seller answer a PayPal dispute in English.
Use ONLY facts present in the input (dispute, invoice, tracking, messages, seller_notes). Never invent dates, amounts, tracking numbers, delivery status or conversations.
If something important is missing, list it in missing_information and set recommended_action to "needs_seller_input".
- summary: neutral summary of the case for the seller.
- timeline: dated events, each citing its source field.
- reply_draft: a calm, polite English message to the buyer (max 2000 characters).
- evidence_notes: notes for PayPal explaining the evidence (max 2000 characters).
- reply_draft and evidence_notes are sent exactly as you write them. Write final text only: no placeholders, no square brackets, no notes or instructions to the seller (never "[Seller: ...]" or "(Seller: ...)").
  Anything the seller still has to do or find (attach a receipt, add a screenshot, check a date) goes in missing_information, never in reply_draft or evidence_notes.
- Only the files listed in attachments are attached. Never write that something is attached or enclosed unless it is in that list; if attachments is empty, do not mention attachments at all.
- recommended_action: provide_evidence when shipment proof exists for an item-not-received case; send_message when the case is still an inquiry; accept_claim only if the seller notes say they want to refund.
  Only recommend an action listed in dispute.allowed_actions (what PayPal currently allows); otherwise use needs_seller_input.
  If dispute.allowed_actions is empty, PayPal offers the seller no action right now: use wait_for_paypal (the reply draft is still useful for later).`;

export class Agent {
  constructor(
    private readonly ai: AiProvider,
    private readonly config: AgentConfig,
  ) {}

  /** Task 1: Japanese item -> English listing, USD estimate, customs line, HS code candidate. */
  async draftListing(item: JpItem): Promise<Listing> {
    const { value, provider, model, fallbackFrom } = await runJsonTask(this.ai, {
      task: "draftListing",
      system: LISTING_SYSTEM,
      input: item,
      schema: ListingAiSchema,
      maxTokens: this.config.maxOutputTokens,
    });
    const fx = this.config.fxJpyPerUsd;
    return {
      ...value,
      source: item,
      price: {
        jpy: item.price_jpy,
        usd: usdFromJpy(item.price_jpy, fx),
        fx_jpy_per_usd: fx,
        is_estimate: true,
        note: `Estimate at ${fx} JPY per USD. Check the current rate and add shipping before you bill.`,
      },
      hs_code: { candidate: value.hs_code_candidate, label: "check before use" },
      generated_by: { provider, ...(model ? { model } : {}), ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}) },
    };
  }

  private async buyerMessage(listing: ListingForSale) {
    const totals = listingTotals(listing); // throws MoneyError if invalid (price or shipping)
    const currency = totals.currency_code;
    const money = (value: string) => ({ currency_code: currency, value });
    // With shipping, the note writer gets the item price, the shipping and the total (pass 5).
    const amounts = totals.shipping
      ? { item_price: money(totals.item_total), ...(listing.quantity > 1 ? { quantity: listing.quantity, unit_price: money(totals.unit) } : {}), shipping: money(totals.shipping), total: money(totals.total) }
      : { price: listing.price };
    const answer = await runJsonTask(this.ai, {
      task: "buyerMessage",
      system: BILLING_SYSTEM,
      input: { item: listing.title, ...amounts, seller: this.config.sellerBusinessName ?? "" },
      schema: BuyerMessageAiSchema,
      maxTokens: Math.min(this.config.maxOutputTokens, 600),
    });
    answer.value.note = noteMatchingTotal(answer.value.note, listing.title, totals);
    return answer;
  }

  /** Task 2 (invoice path): invoice draft + notification for seller approval. Nothing is sent here. */
  async prepareInvoice(listing: ListingForSale, buyer: Buyer, marker?: string): Promise<PreparedBilling<CreateAndSendInvoicePayload>> {
    const { value, provider, model, fallbackFrom } = await this.buyerMessage(listing);
    const payload = buildInvoicePayload(listing, buyer.alias, value, this.config.sellerBusinessName, marker);
    return {
      payload,
      buyer_message: value,
      generated_by: { provider, ...(model ? { model } : {}), ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}) },
    };
  }

  /** Task 2 (order path, spec 3.5): Orders v2 payment link for seller approval. */
  async preparePaymentLink(listing: ListingForSale, buyer: Buyer, marker?: string): Promise<PreparedBilling<CreatePaymentLinkPayload>> {
    const { value, provider, model, fallbackFrom } = await this.buyerMessage(listing);
    const payload = buildOrderPayload(listing, buyer.alias, this.config, marker);
    return { payload, buyer_message: value, generated_by: { provider, ...(model ? { model } : {}), ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}) } };
  }

  /** Task 3: reminder text per unpaid invoice. Only invoice ids from the input are kept. */
  async nudgeUnpaid(invoices: UnpaidInvoice[]): Promise<{ reminders: PreparedReminder[]; generated_by: GeneratedBy }> {
    if (invoices.length === 0) return { reminders: [], generated_by: { provider: this.ai.name } };
    const { value, provider, model, fallbackFrom } = await runJsonTask(this.ai, {
      task: "nudgeUnpaid",
      system: NUDGE_SYSTEM,
      input: { invoices },
      schema: NudgeAiSchema,
      maxTokens: this.config.maxOutputTokens,
    });
    const known = new Set(invoices.map((i) => i.invoice_id));
    const seen = new Set<string>();
    const reminders: PreparedReminder[] = [];
    for (const r of value.reminders) {
      if (!known.has(r.invoice_id) || seen.has(r.invoice_id)) continue;
      seen.add(r.invoice_id);
      reminders.push({ invoice_id: r.invoice_id, payload: standardReminderPayload(r.invoice_id), copy_for_dm: r.message });
    }
    return { reminders, generated_by: { provider, ...(model ? { model } : {}), ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}) } };
  }

  /** Task 4: evidence summary, timeline, attachments and an English reply draft. */
  async disputeEvidencePack(input: EvidenceInput): Promise<EvidencePack> {
    // The attachments are known before the model answers, so it is told exactly what is attached.
    const { attachments, described } = evidenceAttachments(input);
    const { value, provider, model, fallbackFrom } = await runJsonTask(this.ai, {
      task: "disputeEvidencePack",
      system: EVIDENCE_SYSTEM,
      input: { ...input, attachments: described.map((a) => ({ name: a.name, description: a.description })) },
      schema: EvidencePackAiSchema,
      maxTokens: this.config.maxOutputTokens,
    });

    // Texts sent as they are: seller to-dos and false attachment claims are removed and listed
    // in missing_information instead (pass 5). Too little left to send means the answer is refused.
    for (const field of ["evidence_notes", "reply_draft"] as const) {
      const fixed = repairSendableText(value[field], described);
      if (fixed.text.length < 10) {
        throw new AgentOutputError("The AI answer for disputeEvidencePack had no sendable text left after removing seller instructions", [`${field}: only instructions or placeholders`]);
      }
      value[field] = fixed.text.slice(0, 2000);
      for (const r of fixed.removed) if (value.missing_information.length < 10) value.missing_information.push(r.slice(0, 300));
    }

    // The recommendation never names an action PayPal does not offer now (checked in code too).
    // With no seller action at all it is "wait for PayPal"; missing_information still lists gaps.
    const allowed = input.dispute.allowed_actions;
    const PAYPAL_ACTIONS: readonly string[] = ["provide_evidence", "send_message", "accept_claim"];
    if (allowed && allowed.length === 0) value.recommended_action = "wait_for_paypal";
    else if (allowed && PAYPAL_ACTIONS.includes(value.recommended_action) && !allowed.includes(value.recommended_action)) value.recommended_action = "needs_seller_input";

    const unverified = [
      ...new Set([
        ...unsupportedFacts(value.reply_draft, input),
        ...unsupportedFacts(value.evidence_notes, input),
        ...unsupportedFacts(value.summary, input),
        ...value.timeline.flatMap((t) => unsupportedFacts(`${t.date} ${t.event}`, input)),
      ]),
    ];

    const evidence: DisputeEvidence = input.tracking
      ? {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: {
            tracking_info: [
              {
                ...disputeCarrier(input.tracking.carrier),
                tracking_number: input.tracking.tracking_number,
                ...(input.tracking.tracking_url ? { tracking_url: input.tracking.tracking_url } : {}),
              },
            ],
          },
          notes: value.evidence_notes,
        }
      : { evidence_type: "OTHER", notes: value.evidence_notes };

    return {
      ...value,
      unverified_facts: unverified,
      attachments: described,
      evidence_payload: { disputeId: input.dispute.dispute_id, evidences: [evidence], attachments },
      message_payload: { disputeId: input.dispute.dispute_id, message: value.reply_draft },
      generated_by: { provider, ...(model ? { model } : {}), ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}) },
    };
  }
}

/** PayPal's standard reminder: PayPal ignores custom subject/note on remind, so only flags are sent. */
export function standardReminderPayload(invoiceId: string): SendReminderPayload {
  return { invoiceId, notification: { send_to_recipient: true, send_to_invoicer: true } };
}

/**
 * Pure builder for the Invoicing v2 draft + send notification (shared by tasks and chat tools).
 * The recipient is a demo alias; the executor adds the email address at execution time.
 */
export function buildInvoicePayload(
  listing: ListingForSale,
  recipientAlias: string,
  message: { note: string },
  sellerBusinessName?: string,
  /** Sale marker ("Okuri OK-1042 US") for `detail.reference`, so the app recognises its own invoices. */
  reference?: string,
): CreateAndSendInvoicePayload {
  const currency = listing.price.currency_code;
  const totals = listingTotals(listing); // throws MoneyError if invalid (price or shipping)
  const unit = totals.unit;
  const invoice: InvoiceDraft = {
    detail: {
      currency_code: listing.price.currency_code,
      ...(reference ? { reference } : {}),
      note: message.note,
      payment_term: { term_type: "NET_10" },
    },
    ...(sellerBusinessName ? { invoicer: { business_name: sellerBusinessName } } : {}),
    items: [
      {
        name: listing.title.slice(0, 200),
        ...(listing.description ? { description: listing.description.slice(0, 1000) } : {}),
        quantity: String(listing.quantity),
        unit_amount: { currency_code: currency, value: unit },
        unit_of_measure: "QUANTITY",
      },
    ],
    // Invoicing v2 shipping charge, same currency; PayPal adds it to the invoice total.
    ...(totals.shipping ? { amount: { breakdown: { shipping: { amount: { currency_code: currency, value: totals.shipping } } } } } : {}),
  };
  // The AI note goes in invoice.detail.note (supported, shown to the buyer). The send
  // notification carries flags only: PayPal does not honor a custom subject or note there.
  return { recipient_alias: recipientAlias, invoice, notification: { send_to_recipient: true, send_to_invoicer: true } };
}

/**
 * Pure builder for an Orders v2 payment link (spec 3.5 fallback path). The recipient is a demo
 * alias; the executor adds `payment_source.paypal.email_address` at execution time.
 */
export function buildOrderPayload(
  listing: ListingForSale,
  recipientAlias: string,
  config: Pick<AgentConfig, "publicBaseUrl" | "sellerBusinessName">,
  /** Sale marker for `purchase_units[0].custom_id` (not shown to the buyer). */
  customId?: string,
): CreatePaymentLinkPayload {
  const currency = listing.price.currency_code;
  const { unit, item_total: itemTotal, shipping, total } = listingTotals(listing); // throws MoneyError if invalid
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  const order: CreateOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: listing.title.slice(0, 127),
        ...(customId ? { custom_id: customId } : {}),
        amount: {
          currency_code: currency,
          value: total,
          breakdown: { item_total: { currency_code: currency, value: itemTotal }, ...(shipping ? { shipping: { currency_code: currency, value: shipping } } : {}) },
        },
        items: [
          {
            name: listing.title.slice(0, 127),
            quantity: String(listing.quantity),
            unit_amount: { currency_code: currency, value: unit },
            category: "PHYSICAL_GOODS",
          },
        ],
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          ...(config.sellerBusinessName ? { brand_name: config.sellerBusinessName.slice(0, 127) } : {}),
          shipping_preference: "GET_FROM_FILE",
          user_action: "PAY_NOW",
          return_url: `${base}/paypal/return`,
          cancel_url: `${base}/paypal/cancel`,
        },
      },
    },
  };
  return { recipient_alias: recipientAlias, order };
}

/** Disputes `tracking_info` uses `carrier_name` (+ `carrier_name_other` for OTHER). */
function disputeCarrier(name: string): { carrier_name: string; carrier_name_other?: string } {
  const c = carrierFor(name, "disputes");
  return { carrier_name: c.carrier, ...(c.carrier_name_other ? { carrier_name_other: c.carrier_name_other } : {}) };
}

/**
 * The files attached to an evidence submission: an invoice summary PDF when the invoice is
 * known (with the shipment line when tracking is given). Computed before the model call.
 */
function evidenceAttachments(input: EvidenceInput): { attachments: EvidenceAttachment[]; described: EvidencePack["attachments"] } {
  const attachments: EvidenceAttachment[] = [];
  const described: EvidencePack["attachments"] = [];
  if (input.invoice) {
    const inv = input.invoice;
    const pdf = renderTextPdf(`Invoice ${inv.invoice_number ?? inv.invoice_id} (summary)`, [
      `Invoice id: ${inv.invoice_id}`,
      ...(inv.invoice_date ? [`Invoice date: ${inv.invoice_date}`] : []),
      ...(inv.status ? [`Status: ${inv.status}`] : []),
      ...(inv.amount ? [`Amount: ${inv.amount.value} ${inv.amount.currency_code}`] : []),
      ...(inv.paid_date ? [`Paid: ${inv.paid_date}`] : []),
      "",
      "Items:",
      ...inv.items.map((i) => `- ${i.name} x ${i.quantity ?? "1"}${i.unit_amount ? ` @ ${i.unit_amount.value} ${i.unit_amount.currency_code}` : ""}`),
      ...(input.tracking ? ["", `Shipped with ${input.tracking.carrier}, tracking ${input.tracking.tracking_number}${input.tracking.shipped_date ? ` on ${input.tracking.shipped_date}` : ""}`] : []),
    ]);
    const name = `invoice-${(inv.invoice_number ?? inv.invoice_id).replace(/[^A-Za-z0-9-]/g, "")}.pdf`;
    attachments.push({ name, contentType: "application/pdf", base64: Buffer.from(pdf).toString("base64") });
    described.push({
      name,
      contentType: "application/pdf",
      description: input.tracking ? "Invoice summary generated from PayPal invoice data, with the carrier and tracking number" : "Invoice summary generated from PayPal invoice data",
    });
  }
  return { attachments, described };
}

/** Carrier names for the evidence notes, from Disputes v1 `carrier_name` codes. */
const DISPUTE_CARRIER_NAMES: Record<string, string> = {
  JPN_JAPAN_POST: "Japan Post",
  JPN_YAMATO: "Yamato Transport",
  JPN_SAGAWA: "Sagawa Express",
  DHL_JP: "DHL Japan",
  DHL: "DHL",
  FEDEX: "FedEx",
  UPS: "UPS",
  USPS: "USPS",
};

/**
 * After PayPal refused an evidence type (EVIDENCE_TYPE_IS_NOT_ALLOWED): the same submission as
 * evidence type OTHER, with the shipment details (carrier, tracking number, tracking URL) written
 * into the notes, because OTHER carries no tracking_info. Attachments stay as they were. The
 * shipment lines are kept whole; the earlier notes are shortened if the 2000-character limit
 * needs it. Undefined when everything was OTHER already (no loop).
 */
export function otherEvidenceFallback(payload: ProvideEvidencePayload): ProvideEvidencePayload | undefined {
  if (!payload.evidences.some((e) => e.evidence_type !== "OTHER")) return undefined;
  const notes = payload.evidences.map((e) => e.notes?.trim()).filter((n): n is string => Boolean(n));
  const shipments = payload.evidences.flatMap((e) => e.evidence_info?.tracking_info ?? []);
  const lines = shipments.map((t) => {
    const carrier = t.carrier_name === "OTHER" ? (t.carrier_name_other ?? "another carrier") : (DISPUTE_CARRIER_NAMES[t.carrier_name] ?? t.carrier_name);
    return `Shipment: carrier ${carrier}, tracking number ${t.tracking_number}${t.tracking_url ? `, tracking page ${t.tracking_url}` : ""}.`;
  });
  const tail = lines.join("\n");
  const room = 2000 - (tail ? tail.length + 2 : 0);
  let head = [...new Set(notes)].join("\n\n");
  if (head.length > room) head = `${head.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  const text = [head, tail].filter(Boolean).join("\n\n").slice(0, 2000);
  return {
    disputeId: payload.disputeId,
    evidences: [{ evidence_type: "OTHER", notes: text || "Evidence for this case." }],
    attachments: payload.attachments.map((a) => ({ ...a })),
  };
}

/** Amounts written in a text: next to a currency sign or code, or with two decimals. */
const AMOUNT = /(?:US\$|\$|€|£|¥|\b[A-Z]{3}\b)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:\b[A-Z]{3}\b|dollars?\b|yen\b)|\b(\d[\d,]*\.\d{2})\b/g;

/** The amounts in a text, in hundredths (so 80, 80.00 and 80.0 compare equal). */
export function amountsIn(text: string): number[] {
  return [...text.matchAll(AMOUNT)].map((m) => Math.round(Number((m[1] ?? m[2] ?? m[3] ?? "").replace(/,/g, "")) * 100)).filter((n) => Number.isFinite(n));
}

/**
 * The buyer note must not contradict what PayPal bills (pass 5: "The price is 80.00 USD" on a
 * 95.00 USD invoice). Amounts other than the unit price, item total, shipping and total make the
 * app write a plain note itself; a note that names an amount but not the total gets the total
 * (with item price and shipping) appended. A note without amounts stays as it is.
 */
export function noteMatchingTotal(note: string, title: string, totals: ReturnType<typeof listingTotals>): string {
  const cur = totals.currency_code;
  const cents = (v: string) => Math.round(Number(v) * 100);
  const allowed = new Set([totals.unit, totals.item_total, totals.total, ...(totals.shipping ? [totals.shipping] : [])].map(cents));
  const found = amountsIn(note);
  if (found.length === 0) return note;
  const breakdown = totals.shipping ? ` (item ${totals.item_total} ${cur} + shipping ${totals.shipping} ${cur})` : "";
  if (found.some((a) => !allowed.has(a))) {
    return `Thank you for your order of "${title.slice(0, 200)}". The total is ${totals.total} ${cur}${breakdown}. You can pay securely with PayPal.`;
  }
  if (found.includes(cents(totals.total))) return note;
  const tail = ` Total${totals.shipping ? " including shipping" : ""}: ${totals.total} ${cur}${breakdown}.`;
  return `${note.trimEnd().slice(0, 1000 - tail.length)}${tail}`;
}
