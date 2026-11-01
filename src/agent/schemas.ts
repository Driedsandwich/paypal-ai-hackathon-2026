import { z } from "zod";

// ---------- Inputs (validated at the HTTP boundary) ----------

export const ITEM_CONDITIONS = ["new", "used_like_new", "used_good", "used_fair", "handmade"] as const;

/** What the seller types, in Japanese. */
export const JpItemSchema = z.object({
  title_ja: z.string().trim().min(1).max(200),
  description_ja: z.string().max(4000).default(""),
  price_jpy: z.number().int().positive().max(10_000_000),
  condition: z.enum(ITEM_CONDITIONS).optional(),
  category: z.string().max(100).optional(),
  weight_g: z.number().int().positive().max(100_000).optional(),
});
export type JpItem = z.infer<typeof JpItemSchema>;

export const MoneySchema = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. USD"),
  value: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "decimal amount, e.g. 80.00"),
});

/** The part of a listing needed to bill a buyer. */
export const ListingForSaleSchema = z.object({
  title: z.string().trim().min(1).max(127),
  description: z.string().max(1000).default(""),
  price: MoneySchema,
  quantity: z.number().int().positive().max(999).default(1),
});
export type ListingForSale = z.infer<typeof ListingForSaleSchema>;

export const BuyerSchema = z.object({
  email: z.email().max(254),
});
export type Buyer = z.infer<typeof BuyerSchema>;

export const UnpaidInvoiceSchema = z.object({
  invoice_id: z.string().min(1).max(30),
  invoice_number: z.string().max(25).optional(),
  amount: MoneySchema.optional(),
  invoice_date: z.string().max(10).optional(),
  due_date: z.string().max(10).optional(),
  days_outstanding: z.number().int().min(0).max(3650).optional(),
  item_names: z.array(z.string().max(200)).max(20).default([]),
});
export type UnpaidInvoice = z.infer<typeof UnpaidInvoiceSchema>;

export const ShipmentFactsSchema = z.object({
  carrier: z.string().trim().min(1).max(64),
  tracking_number: z.string().trim().min(1).max(64),
  shipped_date: z.string().max(10).optional(),
  tracking_url: z.url().max(250).optional(),
});
export type ShipmentFacts = z.infer<typeof ShipmentFactsSchema>;

/** Inputs to the evidence pack. Built by the server from PayPal data; buyer identity is left out. */
export const EvidenceInputSchema = z.object({
  dispute: z.object({
    dispute_id: z.string(),
    reason: z.string().optional(),
    status: z.string().optional(),
    dispute_life_cycle_stage: z.string().optional(),
    amount: MoneySchema.optional(),
    create_time: z.string().optional(),
    seller_response_due_date: z.string().optional(),
    transaction_id: z.string().optional(),
  }),
  invoice: z
    .object({
      invoice_id: z.string(),
      invoice_number: z.string().optional(),
      invoice_date: z.string().optional(),
      status: z.string().optional(),
      amount: MoneySchema.optional(),
      items: z.array(z.object({ name: z.string(), quantity: z.string().optional(), unit_amount: MoneySchema.optional() })).default([]),
      paid_date: z.string().optional(),
    })
    .optional(),
  tracking: ShipmentFactsSchema.optional(),
  messages: z
    .array(z.object({ posted_by: z.string().optional(), time_posted: z.string().optional(), content: z.string().max(2000) }))
    .max(30)
    .default([]),
  seller_notes: z.string().max(2000).optional(),
});
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

// ---------- Model outputs (validated before use) ----------

export const ListingAiSchema = z.object({
  title: z.string().min(5).max(80),
  description: z.string().min(20).max(3000),
  item_specifics: z.array(z.object({ name: z.string().min(1).max(40), value: z.string().min(1).max(120) })).max(15),
  customs_description: z.string().min(3).max(120),
  hs_code_candidate: z.string().regex(/^(\d{4}(\.\d{2}){0,2})?$/, "HS code like 6912.00, or empty"),
});
export type ListingAi = z.infer<typeof ListingAiSchema>;

export const BuyerMessageAiSchema = z.object({
  subject: z.string().min(3).max(200),
  note: z.string().min(10).max(1000),
});
export type BuyerMessageAi = z.infer<typeof BuyerMessageAiSchema>;

export const NudgeAiSchema = z.object({
  reminders: z
    .array(z.object({ invoice_id: z.string().min(1), subject: z.string().min(3).max(200), note: z.string().min(10).max(1000) }))
    .max(50),
});
export type NudgeAi = z.infer<typeof NudgeAiSchema>;

export const EVIDENCE_ACTIONS = ["provide_evidence", "send_message", "accept_claim", "needs_seller_input"] as const;

export const EvidencePackAiSchema = z.object({
  summary: z.string().min(10).max(1500),
  timeline: z
    .array(z.object({ date: z.string().max(40), event: z.string().min(3).max(300), source: z.enum(["dispute", "invoice", "tracking", "messages", "seller_notes"]) }))
    .max(30),
  reply_draft: z.string().min(10).max(2000),
  evidence_notes: z.string().min(10).max(2000),
  recommended_action: z.enum(EVIDENCE_ACTIONS),
  missing_information: z.array(z.string().max(300)).max(10),
});
export type EvidencePackAi = z.infer<typeof EvidencePackAiSchema>;
