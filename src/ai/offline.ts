// Offline answers for AI_PROVIDER=fake: deterministic, rule-based, no network.
// They exist so the whole app (and the tests) run without an AI key. Real
// providers produce better English; these answers say "[offline demo]" where
// the seller sees them, and use only facts from the input.
import { inputFromPrompt } from "../agent/json-task.js";
import type { AiCompletionRequest } from "./provider.js";
import type { FakeReplyValue } from "./fake-provider.js";
import type { AiToolCallRecord } from "./provider.js";

function describeResult(calls: AiToolCallRecord[], what: string): string {
  const out = calls[0]?.output as Record<string, unknown> | unknown[] | undefined;
  if (out && !Array.isArray(out) && typeof out.error === "string") return `[offline demo] I could not read your ${what}: ${out.error}`;
  const items = Array.isArray(out) ? out : ((out as { invoices?: unknown[] } | undefined)?.invoices ?? []);
  if (items.length === 0) return `[offline demo] You have no ${what} right now.`;
  const lines = items.slice(0, 10).map((i) => {
    const r = i as Record<string, any>;
    return `- ${r.invoice_number ?? r.id ?? r.dispute_id}: ${r.status ?? ""}${r.amount?.value ? ` ${r.amount.value} ${r.amount.currency_code ?? ""}` : ""}`;
  });
  return `[offline demo] Your ${what}:\n${lines.join("\n")}`;
}

const GLOSSARY: Array<[RegExp, string]> = [
  [/抹茶碗|茶碗/, "tea bowl"],
  [/湯呑/, "teacup"],
  [/急須/, "teapot"],
  [/鉄瓶/, "cast iron kettle"],
  [/徳利/, "sake bottle"],
  [/ぐい呑|お猪口/, "sake cup"],
  [/花瓶/, "flower vase"],
  [/皿/, "plate"],
  [/こけし/, "kokeshi doll"],
  [/着物/, "kimono"],
  [/帯/, "obi sash"],
  [/手ぬぐい/, "tenugui towel"],
  [/風呂敷/, "furoshiki wrapping cloth"],
  [/扇子/, "folding fan"],
  [/包丁/, "kitchen knife"],
  [/箸/, "chopsticks"],
  [/レンズ/, "camera lens"],
  [/フィルムカメラ/, "film camera"],
  [/カメラ/, "camera"],
  [/腕時計/, "wristwatch"],
  [/フィギュア/, "figure"],
  [/カード/, "trading card"],
];

const MATERIALS: Array<[RegExp, string]> = [
  [/陶器|陶/, "ceramic (stoneware)"],
  [/磁器|有田|伊万里/, "porcelain"],
  [/鉄/, "cast iron"],
  [/木|木製/, "wood"],
  [/竹/, "bamboo"],
  [/絹|シルク/, "silk"],
  [/綿|コットン/, "cotton"],
  [/漆/, "lacquer"],
  [/ガラス/, "glass"],
];

const HS_HINTS: Array<[RegExp, string]> = [
  [/茶碗|湯呑|皿|花瓶|徳利|ぐい呑|お猪口|急須/, "6912.00"],
  [/鉄瓶/, "7323.91"],
  [/こけし/, "4420.11"],
  [/レンズ/, "9002.11"],
  [/カメラ/, "9006.59"],
  [/着物/, "6211.49"],
  [/箸/, "4419.90"],
  [/包丁/, "8211.91"],
];

const CONDITIONS: Record<string, string> = {
  new: "New",
  used_like_new: "Used - like new",
  used_good: "Used - good",
  used_fair: "Used - fair",
  handmade: "New, handmade",
};

function firstMatch(text: string, table: Array<[RegExp, string]>): string | undefined {
  return table.find(([re]) => re.test(text))?.[1];
}

const SMALL_WORDS = new Set(["from", "of", "and", "with", "in"]);
function titleCase(s: string): string {
  return s.replace(/\b\w+/g, (w, i: number) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)));
}

function json(value: unknown): FakeReplyValue {
  return JSON.stringify(value);
}

function listing(input: Record<string, unknown>): FakeReplyValue {
  const ja = `${String(input.title_ja ?? "")} ${String(input.description_ja ?? "")}`;
  const noun = firstMatch(ja, GLOSSARY) ?? (typeof input.category === "string" && input.category ? input.category : "item");
  const material = firstMatch(ja, MATERIALS);
  const handmade = /手作り|手づくり|ハンドメイド|作家|手びねり|ろくろ/.test(ja) || input.condition === "handmade";
  const condition = CONDITIONS[String(input.condition ?? "")];
  const words = [handmade ? "Handmade" : "", "Japanese", material ? material.replace(/ \(.*\)/, "") : "", noun].filter(Boolean);
  const title = titleCase(`${words.join(" ")} from Japan`).slice(0, 80);
  const specifics = [
    { name: "Origin", value: "Japan" },
    ...(condition ? [{ name: "Condition", value: condition }] : []),
    ...(material ? [{ name: "Material", value: material }] : []),
    ...(typeof input.weight_g === "number" ? [{ name: "Weight", value: `${input.weight_g} g` }] : []),
  ];
  return json({
    title: title.length >= 5 ? title : "Item from Japan",
    description: [
      `[offline demo] ${titleCase(noun)} from Japan${handmade ? ", made by hand" : ""}.`,
      condition ? `Condition: ${condition}.` : "Please see the photos for condition.",
      "Shipped from Japan with tracking. Original Japanese listing:",
      String(input.title_ja ?? ""),
    ].join("\n\n"),
    item_specifics: specifics,
    customs_description: `${material ? `${material.replace(/ \(.*\)/, "")} ` : ""}${noun}, ${handmade ? "handmade, " : ""}${condition?.startsWith("Used") ? "used" : "new"}`.slice(0, 120),
    hs_code_candidate: firstMatch(ja, HS_HINTS) ?? "",
  });
}

function buyerMessage(input: Record<string, unknown>): FakeReplyValue {
  const item = String(input.item ?? "your item");
  const seller = typeof input.seller === "string" && input.seller ? input.seller : "the seller";
  return json({
    subject: `Payment request: ${item}`.slice(0, 200),
    note: `Hello! Thank you for your interest in "${item}". You can pay securely with PayPal using the link in this message. I will ship from Japan as soon as the payment arrives. Best regards, ${seller}`.slice(0, 1000),
  });
}

function nudge(input: { invoices?: Array<Record<string, unknown>> }): FakeReplyValue {
  return json({
    reminders: (input.invoices ?? []).map((inv) => {
      const no = inv.invoice_number ? `#${String(inv.invoice_number)}` : "";
      const amount = inv.amount as { value?: string; currency_code?: string } | undefined;
      return {
        invoice_id: String(inv.invoice_id),
        subject: `Friendly reminder: invoice ${no}`.trim(),
        note: `Hello! Just a friendly reminder about invoice ${no}${amount?.value ? ` for ${amount.value} ${amount.currency_code ?? ""}`.trimEnd() : ""}. You can pay securely with PayPal using the link in this message. Thank you!`,
      };
    }),
  });
}

function evidence(input: Record<string, any>): FakeReplyValue {
  const d = input.dispute ?? {};
  const inv = input.invoice;
  const tr = input.tracking;
  const timeline: Array<{ date: string; event: string; source: string }> = [];
  if (inv?.invoice_date) timeline.push({ date: inv.invoice_date, event: `Invoice ${inv.invoice_number ?? inv.invoice_id} issued`, source: "invoice" });
  if (inv?.paid_date) timeline.push({ date: inv.paid_date, event: "Buyer paid the invoice", source: "invoice" });
  if (tr) timeline.push({ date: tr.shipped_date ?? "", event: `Shipped with ${tr.carrier}, tracking ${tr.tracking_number}`, source: "tracking" });
  if (d.create_time) timeline.push({ date: String(d.create_time).slice(0, 10), event: `Dispute opened${d.reason ? ` (${d.reason})` : ""}`, source: "dispute" });
  const missing: string[] = [];
  if (!tr) missing.push("Tracking number and carrier for the shipment");
  if (!inv) missing.push("The invoice or order this dispute is about");
  const wantsRefund = typeof input.seller_notes === "string" && /refund|返金/i.test(input.seller_notes);
  const action = wantsRefund ? "accept_claim" : !tr || !inv ? "needs_seller_input" : d.dispute_life_cycle_stage === "INQUIRY" ? "send_message" : "provide_evidence";
  return json({
    summary: `[offline demo] Dispute ${d.dispute_id}${d.reason ? ` (${d.reason})` : ""}${d.amount ? ` for ${d.amount.value} ${d.amount.currency_code}` : ""}. ${tr ? `The item was shipped with ${tr.carrier} (tracking ${tr.tracking_number}).` : "No shipment information was provided."}`,
    timeline,
    reply_draft: `Hello, thank you for contacting me and I am sorry for the trouble. ${tr ? `Your parcel was sent with ${tr.carrier}. The tracking number is ${tr.tracking_number}, so you can follow it on the carrier's website.` : "I am checking the shipment details and will update you shortly."} Please let me know if there is anything else I can do.`,
    evidence_notes: tr
      ? `The seller shipped the item with ${tr.carrier}, tracking number ${tr.tracking_number}.${inv ? ` It matches invoice ${inv.invoice_number ?? inv.invoice_id}.` : ""}`
      : "The seller is collecting shipment information.",
    recommended_action: action,
    missing_information: missing,
  });
}

function chat(request: AiCompletionRequest): FakeReplyValue {
  const last = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const has = (name: string) => request.tools?.some((t) => t.name === name);
  if (/invoice|請求|unpaid|未払/i.test(last) && has("list_invoices")) {
    return { text: "", toolCalls: [{ name: "list_invoices", input: { page_size: 10 } }], after: (calls) => describeResult(calls, "invoices") };
  }
  if (/dispute|紛争|claim|クレーム/i.test(last) && has("list_disputes")) {
    return { text: "", toolCalls: [{ name: "list_disputes", input: {} }], after: (calls) => describeResult(calls, "disputes") };
  }
  return {
    text: "[offline demo] I can list your invoices or disputes, draft English listings, and prepare invoices, reminders, tracking and dispute replies for your approval. Try: \"show unpaid invoices\".",
  };
}

/** Reply function for FakeAiProvider when AI_PROVIDER=fake. */
export function offlineReply(request: AiCompletionRequest): FakeReplyValue {
  const prompt = request.messages.find((m) => m.role === "user" && m.content.includes("<input>"))?.content ?? "";
  const input = (prompt ? inputFromPrompt(prompt) : undefined) as Record<string, any> | undefined;
  switch (request.task) {
    case "draftListing":
      return listing(input ?? {});
    case "buyerMessage":
      return buyerMessage(input ?? {});
    case "nudgeUnpaid":
      return nudge(input ?? {});
    case "disputeEvidencePack":
      return evidence(input ?? {});
    default:
      return chat(request);
  }
}
