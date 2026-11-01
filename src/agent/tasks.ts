import { renderTextPdf } from "../docs/simple-pdf.js";
import type { AiProvider } from "../ai/provider.js";
import { formatMinor, multiplyMinor, normalizeAmount, toMinor, usdFromJpy } from "../money.js";
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
import { runJsonTask } from "./json-task.js";
import {
  BuyerMessageAiSchema,
  EvidencePackAiSchema,
  ListingAiSchema,
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
}

export interface Listing extends ListingAi {
  source: JpItem;
  price: { jpy: number; usd: string; fx_jpy_per_usd: number; is_estimate: true; note: string };
  hs_code: { candidate: string; label: "check before use" };
  generated_by: GeneratedBy;
}

export interface PreparedBilling<P> {
  payload: P;
  buyer_message: { subject: string; note: string };
  generated_by: GeneratedBy;
}

export interface PreparedReminder {
  invoice_id: string;
  payload: SendReminderPayload;
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

const BILLING_SYSTEM = `You write the short message a small Japanese seller sends with a PayPal payment request to an overseas buyer.
Write friendly, clear English. Mention the item and that payment is handled securely by PayPal.
Do not invent shipping dates, discounts, tracking numbers or promises. Max 1000 characters for note.`;

const NUDGE_SYSTEM = `You write polite payment reminders for unpaid PayPal invoices from a small Japanese seller to overseas buyers.
One reminder per input invoice, using the same invoice_id. Be friendly and brief; never threaten, never add fees or deadlines that are not in the input.`;

const EVIDENCE_SYSTEM = `You help a small Japanese seller answer a PayPal dispute in English.
Use ONLY facts present in the input (dispute, invoice, tracking, messages, seller_notes). Never invent dates, amounts, tracking numbers, delivery status or conversations.
If something important is missing, list it in missing_information and set recommended_action to "needs_seller_input".
- summary: neutral summary of the case for the seller.
- timeline: dated events, each citing its source field.
- reply_draft: a calm, polite English message to the buyer (max 2000 characters).
- evidence_notes: notes for PayPal explaining the evidence (max 2000 characters).
- recommended_action: provide_evidence when shipment proof exists for an item-not-received case; send_message when the case is still an inquiry; accept_claim only if the seller notes say they want to refund.`;

export class Agent {
  constructor(
    private readonly ai: AiProvider,
    private readonly config: AgentConfig,
  ) {}

  /** Task 1: Japanese item -> English listing, USD estimate, customs line, HS code candidate. */
  async draftListing(item: JpItem): Promise<Listing> {
    const { value, provider, model } = await runJsonTask(this.ai, {
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
      generated_by: { provider, ...(model ? { model } : {}) },
    };
  }

  private async buyerMessage(listing: ListingForSale) {
    return runJsonTask(this.ai, {
      task: "buyerMessage",
      system: BILLING_SYSTEM,
      input: { item: listing.title, price: listing.price, seller: this.config.sellerBusinessName ?? "" },
      schema: BuyerMessageAiSchema,
      maxTokens: Math.min(this.config.maxOutputTokens, 600),
    });
  }

  /** Task 2 (invoice path): invoice draft + notification for seller approval. Nothing is sent here. */
  async prepareInvoice(listing: ListingForSale, buyer: Buyer): Promise<PreparedBilling<CreateAndSendInvoicePayload>> {
    const { value, provider, model } = await this.buyerMessage(listing);
    const payload = buildInvoicePayload(listing, buyer, value, this.config.sellerBusinessName);
    return {
      payload,
      buyer_message: value,
      generated_by: { provider, ...(model ? { model } : {}) },
    };
  }

  /** Task 2 (order path, spec 3.5): Orders v2 payment link for seller approval. */
  async preparePaymentLink(listing: ListingForSale): Promise<PreparedBilling<CreatePaymentLinkPayload>> {
    const { value, provider, model } = await this.buyerMessage(listing);
    const payload = buildOrderPayload(listing, this.config);
    return { payload, buyer_message: value, generated_by: { provider, ...(model ? { model } : {}) } };
  }

  /** Task 3: reminder text per unpaid invoice. Only invoice ids from the input are kept. */
  async nudgeUnpaid(invoices: UnpaidInvoice[]): Promise<{ reminders: PreparedReminder[]; generated_by: GeneratedBy }> {
    if (invoices.length === 0) return { reminders: [], generated_by: { provider: this.ai.name } };
    const { value, provider, model } = await runJsonTask(this.ai, {
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
      reminders.push({
        invoice_id: r.invoice_id,
        payload: { invoiceId: r.invoice_id, notification: { subject: r.subject, note: r.note, send_to_recipient: true, send_to_invoicer: true } },
      });
    }
    return { reminders, generated_by: { provider, ...(model ? { model } : {}) } };
  }

  /** Task 4: evidence summary, timeline, attachments and an English reply draft. */
  async disputeEvidencePack(input: EvidenceInput): Promise<EvidencePack> {
    const { value, provider, model } = await runJsonTask(this.ai, {
      task: "disputeEvidencePack",
      system: EVIDENCE_SYSTEM,
      input,
      schema: EvidencePackAiSchema,
      maxTokens: this.config.maxOutputTokens,
    });

    const unverified = [
      ...new Set([
        ...unsupportedFacts(value.reply_draft, input),
        ...unsupportedFacts(value.evidence_notes, input),
        ...unsupportedFacts(value.summary, input),
        ...value.timeline.flatMap((t) => unsupportedFacts(`${t.date} ${t.event}`, input)),
      ]),
    ];

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
      described.push({ name, contentType: "application/pdf", description: "Invoice summary generated from PayPal invoice data" });
    }

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
      generated_by: { provider, ...(model ? { model } : {}) },
    };
  }
}

/** Pure builder for the Invoicing v2 draft + send notification (shared by tasks and chat tools). */
export function buildInvoicePayload(
  listing: ListingForSale,
  buyer: Buyer,
  message: { subject: string; note: string },
  sellerBusinessName?: string,
): CreateAndSendInvoicePayload {
  const currency = listing.price.currency_code;
  const unit = normalizeAmount(listing.price.value, currency); // throws MoneyError if invalid
  const invoice: InvoiceDraft = {
    detail: {
      currency_code: listing.price.currency_code,
      note: message.note,
      payment_term: { term_type: "NET_10" },
    },
    ...(sellerBusinessName ? { invoicer: { business_name: sellerBusinessName } } : {}),
    primary_recipients: [{ billing_info: { email_address: buyer.email } }],
    items: [
      {
        name: listing.title.slice(0, 200),
        ...(listing.description ? { description: listing.description.slice(0, 1000) } : {}),
        quantity: String(listing.quantity),
        unit_amount: { currency_code: currency, value: unit },
        unit_of_measure: "QUANTITY",
      },
    ],
  };
  return { invoice, notification: { subject: message.subject, send_to_recipient: true, send_to_invoicer: true } };
}

/** Pure builder for an Orders v2 payment link (spec 3.5 fallback path). */
export function buildOrderPayload(
  listing: ListingForSale,
  config: Pick<AgentConfig, "publicBaseUrl" | "sellerBusinessName">,
): CreatePaymentLinkPayload {
  const currency = listing.price.currency_code;
  const unitMinor = toMinor(listing.price.value, currency); // throws MoneyError if invalid
  const unit = formatMinor(unitMinor, currency);
  const total = formatMinor(multiplyMinor(unitMinor, listing.quantity), currency);
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  const order: CreateOrderRequest = {
    intent: "CAPTURE",
    purchase_units: [
      {
        description: listing.title.slice(0, 127),
        amount: {
          currency_code: currency,
          value: total,
          breakdown: { item_total: { currency_code: currency, value: total } },
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
  return { order };
}

/** Disputes `tracking_info` uses `carrier_name` (+ `carrier_name_other` for OTHER). */
function disputeCarrier(name: string): { carrier_name: string; carrier_name_other?: string } {
  const c = carrierFor(name, "disputes");
  return { carrier_name: c.carrier, ...(c.carrier_name_other ? { carrier_name_other: c.carrier_name_other } : {}) };
}
