import { describe, expect, it } from "vitest";
import { createAiProviderFromEnv, FakeAiProvider } from "../src/ai/index.js";
import { offlineReply } from "../src/ai/offline.js";
import { unsupportedFacts } from "../src/agent/fact-check.js";
import { AgentOutputError, extractJson } from "../src/agent/json-task.js";
import { EvidenceInputSchema, JpItemSchema } from "../src/agent/schemas.js";
import { Agent, type AgentConfig } from "../src/agent/tasks.js";
import { agentTools, chat } from "../src/agent/tools.js";
import { DemoBuyers } from "../src/demo/buyers.js";
import { ProposalStore } from "../src/proposals/store.js";
import { fakeEmail } from "./helpers/fake-fetch.js";
import { paypalWith } from "./helpers/paypal.js";

const BUYERS = new DemoBuyers([fakeEmail("b1"), fakeEmail("b2")]);
const TOOL_BASE = { agentConfig: undefined as unknown as AgentConfig, sessionId: "session-me", buyers: BUYERS };
const CONFIG: AgentConfig = { fxJpyPerUsd: 150, maxOutputTokens: 800, sellerBusinessName: "Okuri Demo Shop", publicBaseUrl: "http://localhost:3000/" };
const offline = () => createAiProviderFromEnv({ AI_PROVIDER: "fake" });
/** Offline provider that records requests (test-only option). */
const recordingOffline = () => new FakeAiProvider([offlineReply], { record: true });

const TEA_BOWL = JpItemSchema.parse({
  title_ja: "手作り 抹茶碗 陶器",
  description_ja: "ろくろで作った陶器の抹茶碗です。",
  price_jpy: 12000,
  condition: "handmade",
  weight_g: 350,
});

describe("draftListing", () => {
  it("returns an English listing, a USD estimate computed in code, and a labelled HS candidate", async () => {
    const agent = new Agent(offline(), CONFIG);
    const listing = await agent.draftListing(TEA_BOWL);
    expect(listing.title).toMatch(/Tea Bowl/);
    expect(listing.title.length).toBeLessThanOrEqual(80);
    expect(listing.price).toMatchObject({ jpy: 12000, usd: "80.00", fx_jpy_per_usd: 150, is_estimate: true });
    expect(listing.hs_code).toEqual({ candidate: "6912.00", label: "check before use" });
    expect(listing.customs_description).toMatch(/ceramic tea bowl/i);
    expect(listing.item_specifics).toContainEqual({ name: "Weight", value: "350 g" });
    expect(listing.generated_by.provider).toBe("fake");
  });

  it("uses FX_JPY_PER_USD for the estimate", async () => {
    const listing = await new Agent(offline(), { ...CONFIG, fxJpyPerUsd: 157.3 }).draftListing({ ...TEA_BOWL, price_jpy: 10000 });
    expect(listing.price.usd).toBe("63.57");
  });

  it("retries once with the validation issues, then gives up with AgentOutputError", async () => {
    const good = JSON.stringify({ title: "Japanese Tea Bowl", description: "A handmade tea bowl from Japan.", item_specifics: [], customs_description: "ceramic tea bowl", hs_code_candidate: "6912.00" });
    const ai = new FakeAiProvider(["Sure! here you go: {not json", "```json\n" + good + "\n```"], { record: true });
    const listing = await new Agent(ai, CONFIG).draftListing(TEA_BOWL);
    expect(listing.title).toBe("Japanese Tea Bowl");
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]!.messages.at(-1)!.content).toMatch(/did not match the schema/);

    const bad = new FakeAiProvider([JSON.stringify({ title: "x" })], { record: true });
    const err = await new Agent(bad, CONFIG).draftListing(TEA_BOWL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentOutputError);
    expect((err as AgentOutputError).issues.join(" ")).toMatch(/title/);
    expect(bad.calls).toHaveLength(2);
  });

  it("sends the item to the model and caps output tokens", async () => {
    const ai = recordingOffline();
    await new Agent(ai, CONFIG).draftListing(TEA_BOWL);
    expect(ai.calls[0]!.maxTokens).toBe(800);
    expect(ai.calls[0]!.messages[1]!.content).toContain("抹茶碗");
  });
});

describe("prepareInvoice / preparePaymentLink", () => {
  const listing = { title: "Handmade Japanese Tea Bowl", description: "Stoneware.", price: { currency_code: "USD", value: "80.00" }, quantity: 1 };

  it("builds an Invoicing v2 draft for approval without calling PayPal", async () => {
    const prepared = await new Agent(offline(), CONFIG).prepareInvoice(listing, { alias: "Demo buyer 1" });
    expect(prepared.payload.recipient_alias).toBe("Demo buyer 1");
    expect(JSON.stringify(prepared.payload)).not.toContain("@");
    expect(prepared.payload.invoice).toEqual({
      detail: { currency_code: "USD", note: prepared.buyer_message.note, payment_term: { term_type: "NET_10" } },
      invoicer: { business_name: "Okuri Demo Shop" },
      items: [{ name: "Handmade Japanese Tea Bowl", description: "Stoneware.", quantity: "1", unit_amount: { currency_code: "USD", value: "80.00" }, unit_of_measure: "QUANTITY" }],
    });
    // The AI note travels in invoice.detail.note; the send notification has flags only (PayPal ignores custom subject/note there).
    expect(prepared.payload.notification).toEqual({ send_to_recipient: true, send_to_invoicer: true });
    expect(prepared.payload.invoice.detail.note).toContain("Tea Bowl");
  });

  it("allows other ISO currencies", async () => {
    const prepared = await new Agent(offline(), CONFIG).prepareInvoice({ ...listing, price: { currency_code: "EUR", value: "75.00" } }, { alias: "Demo buyer 2" });
    expect(prepared.payload.invoice.detail.currency_code).toBe("EUR");
  });

  it("builds an Orders v2 payment link with return/cancel URLs and item breakdown", async () => {
    const prepared = await new Agent(offline(), CONFIG).preparePaymentLink({ ...listing, quantity: 2 }, { alias: "Demo buyer 1" });
    expect(prepared.payload.recipient_alias).toBe("Demo buyer 1");
    const unit = prepared.payload.order.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "USD", value: "160.00", breakdown: { item_total: { currency_code: "USD", value: "160.00" } } });
    expect(unit.items?.[0]).toMatchObject({ quantity: "2", unit_amount: { value: "80.00" }, category: "PHYSICAL_GOODS" });
    expect(prepared.payload.order.payment_source?.paypal?.experience_context).toMatchObject({
      return_url: "http://localhost:3000/paypal/return",
      cancel_url: "http://localhost:3000/paypal/cancel",
      user_action: "PAY_NOW",
    });
  });
});

describe("nudgeUnpaid", () => {
  it("drafts one reminder per unpaid invoice and drops ids the model invented", async () => {
    const agent = new Agent(offline(), CONFIG);
    const { reminders } = await agent.nudgeUnpaid([
      { invoice_id: "INV2-A", invoice_number: "0001", amount: { currency_code: "USD", value: "80.00" }, days_outstanding: 9, item_names: [] },
      { invoice_id: "INV2-B", item_names: [] },
    ]);
    expect(reminders.map((r) => r.invoice_id)).toEqual(["INV2-A", "INV2-B"]);
    // PayPal's standard reminder: flags only. The AI text is a DM copy for the seller.
    expect(reminders[0]!.payload).toEqual({ invoiceId: "INV2-A", notification: { send_to_recipient: true, send_to_invoicer: true } });
    expect(reminders[0]!.copy_for_dm).toContain("80.00 USD");

    const liar = new FakeAiProvider([JSON.stringify({ reminders: [{ invoice_id: "INV2-FAKE", message: "Please pay now, thank you." }] })]);
    expect((await new Agent(liar, CONFIG).nudgeUnpaid([{ invoice_id: "INV2-A", item_names: [] }])).reminders).toEqual([]);
  });

  it("does not call the model when nothing is unpaid", async () => {
    const ai = recordingOffline();
    expect((await new Agent(ai, CONFIG).nudgeUnpaid([])).reminders).toEqual([]);
    expect(ai.calls).toHaveLength(0);
  });
});

describe("disputeEvidencePack", () => {
  const input = EvidenceInputSchema.parse({
    dispute: { dispute_id: "PP-D-1234", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "WAITING_FOR_SELLER_RESPONSE", amount: { currency_code: "USD", value: "80.00" }, create_time: "2026-10-28T03:00:00Z" },
    invoice: { invoice_id: "INV2-AAAA", invoice_number: "0001", invoice_date: "2026-10-15", status: "PAID", amount: { currency_code: "USD", value: "80.00" }, items: [{ name: "Tea bowl", quantity: "1" }], paid_date: "2026-10-16" },
    tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP", shipped_date: "2026-10-17" },
  });

  it("builds summary, timeline, PDF attachment, and approval payloads from inputs only", async () => {
    const pack = await new Agent(offline(), CONFIG).disputeEvidencePack(input);
    expect(pack.recommended_action).toBe("provide_evidence");
    expect(pack.unverified_facts).toEqual([]);
    expect(pack.timeline.map((t) => t.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-28"]);
    expect(pack.reply_draft).toContain("EJ123456789JP");
    expect(pack.attachments).toEqual([{ name: "invoice-0001.pdf", contentType: "application/pdf", description: expect.any(String) }]);
    expect(pack.evidence_payload.evidences[0]).toEqual({
      evidence_type: "PROOF_OF_FULFILLMENT",
      evidence_info: { tracking_info: [{ carrier_name: "JPN_JAPAN_POST", tracking_number: "EJ123456789JP" }] },
      notes: pack.evidence_notes,
    });
    expect(Buffer.from(pack.evidence_payload.attachments[0]!.base64, "base64").toString("latin1")).toMatch(/^%PDF-1\.4/);
    expect(pack.message_payload).toEqual({ disputeId: "PP-D-1234", message: pack.reply_draft });
  });

  it("asks for seller input when shipment facts are missing", async () => {
    const pack = await new Agent(offline(), CONFIG).disputeEvidencePack({ ...input, tracking: undefined });
    expect(pack.recommended_action).toBe("needs_seller_input");
    expect(pack.missing_information.join(" ")).toMatch(/Tracking/);
    expect(pack.evidence_payload.evidences[0]!.evidence_type).toBe("OTHER");
  });

  it("never recommends an action PayPal does not offer now", async () => {
    const at = (allowed: string[]) => EvidenceInputSchema.parse({ ...input, dispute: { ...input.dispute, allowed_actions: allowed } });
    // The offline rules would pick provide_evidence (tracking and invoice given).
    expect((await new Agent(offline(), CONFIG).disputeEvidencePack(at(["provide_evidence"]))).recommended_action).toBe("provide_evidence");
    expect((await new Agent(offline(), CONFIG).disputeEvidencePack(at(["accept_claim"]))).recommended_action).toBe("needs_seller_input");
    const none = await new Agent(offline(), CONFIG).disputeEvidencePack(at([]));
    expect(none.recommended_action).toBe("wait_for_paypal");
    expect(none.reply_draft).toContain("EJ123456789JP");
  });

  it("flags facts the model made up", async () => {
    const liar = new FakeAiProvider([
      JSON.stringify({
        summary: "The buyer received the parcel.",
        timeline: [{ date: "2026-10-19", event: "Delivered", source: "tracking" }],
        reply_draft: "Your parcel EJ999999999JP was delivered on 2026-10-19. We refunded 15.00 already.",
        evidence_notes: "Delivered according to the carrier.",
        recommended_action: "provide_evidence",
        missing_information: [],
      }),
    ]);
    const pack = await new Agent(liar, CONFIG).disputeEvidencePack(input);
    expect(pack.unverified_facts.sort()).toEqual(["15.00", "2026-10-19", "EJ999999999JP"]);
  });
});

describe("fact check and JSON helpers", () => {
  it("accepts facts present in inputs and flags the rest", () => {
    expect(unsupportedFacts("Paid 1,234.50 on 2026-10-16", { amount: "1234.50", date: "2026-10-16T00:00:00Z" })).toEqual([]);
    expect(unsupportedFacts("Tracking RR000000000JP", {})).toEqual(["RR000000000JP"]);
    expect(extractJson('text ```json\n{"a":1}\n``` more')).toEqual({ a: 1 });
    expect(() => extractJson("none")).toThrow();
  });
});

describe("free chat with tools", () => {
  it("offline chat lists invoices through the read tool", async () => {
    const { client } = paypalWith((c) =>
      c.url.includes("/v2/invoicing/invoices?") ? { json: { total_items: 1, items: [{ id: "INV2-1", status: "SENT", detail: { currency_code: "USD", invoice_number: "0001" } }] } } : undefined,
    );
    const proposals = new ProposalStore(async () => undefined);
    const res = await chat(offline(), { ...TOOL_BASE, paypal: client, proposals, agentConfig: CONFIG, paymentPath: "invoice" }, [{ role: "user", content: "未払いの請求書を見せて" }], 500);
    expect(res.tool_calls).toEqual([{ name: "list_invoices", input: { page_size: 10 } }]);
    expect(res.reply).toContain("- 0001: SENT");
    expect(res.proposals).toEqual([]);

    const noPayPal = await chat(offline(), { ...TOOL_BASE, paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "invoice" }, [{ role: "user", content: "show disputes" }], 500);
    expect(noPayPal.reply).toMatch(/could not read your disputes: PayPal is not configured/);
  });

  it("state-changing tools only create pending proposals", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url.includes("/v1/customer/disputes/PP-D-1")
        ? {
            json: {
              dispute_id: "PP-D-1",
              dispute_life_cycle_stage: "INQUIRY",
              links: ["send-message", "accept-claim"].map((a) => ({ rel: a.replace("-", "_"), href: `https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-D-1/${a}`, method: "POST" })),
            },
          }
        : { json: {} },
    );
    const proposals = new ProposalStore(async () => {
      throw new Error("must not run without approval");
    });
    const ai = new FakeAiProvider([
      {
        text: "I prepared these for your approval.",
        toolCalls: [
          { name: "send_invoice_reminder", input: { invoice_id: "INV2-1", dm_message: "Friendly reminder to pay." } },
          { name: "create_shipment_tracking", input: { carrier: "Japan Post", tracking_number: "EJ123456789JP", transaction_id: "8MC585209K746392H" } },
          { name: "send_dispute_message", input: { dispute_id: "PP-D-1", message: "Hello" } },
          { name: "accept_dispute_claim", input: { dispute_id: "PP-D-1", note: "Refund" } },
          { name: "create_invoice", input: { buyer: "Demo buyer 2", item_title: "Tea bowl", price: { currency_code: "USD", value: "80.00" }, note: "Thanks for your order!" } },
        ],
      },
    ]);
    const res = await chat(ai, { ...TOOL_BASE, paypal: client, proposals, agentConfig: CONFIG, paymentPath: "invoice" }, [{ role: "user", content: "do it all" }], 500);
    expect(res.proposals.map((p) => [p.kind, p.status])).toEqual([
      ["create_and_send_invoice", "pending"],
      ["accept_dispute_claim", "pending"],
      ["send_dispute_message", "pending"],
      ["add_invoice_tracking", "pending"],
      ["send_invoice_reminder", "pending"],
    ]);
    expect(apiCalls().filter((c) => c.method !== "GET")).toHaveLength(0); // only reads (dispute checks)
    expect((res.proposals[3]!.payload as { trackers: Array<{ carrier: string }> }).trackers[0]!.carrier).toBe("JPN_JAPAN_POST");
    expect(res.proposals[0]!.payload).toMatchObject({ recipient_alias: "Demo buyer 2" });
    expect(res.proposals[4]).toMatchObject({ title: "Send PayPal's standard reminder for invoice INV2-1", copyForDm: "Friendly reminder to pay.", payload: { invoiceId: "INV2-1", notification: { send_to_recipient: true, send_to_invoicer: true } } });
    expect(res.proposals.every((p) => p.owner === "session-me")).toBe(true);
    // Another session does not see them.
    expect(proposals.list({ owner: "someone-else" })).toEqual([]);
  });

  it("tool results are redacted before the model sees them (F7)", async () => {
    const { client } = paypalWith((c) =>
      c.url.includes("/v1/customer/disputes/PP-D-1")
        ? { json: { dispute_id: "PP-D-1", messages: [{ posted_by: "BUYER", content: `Call me: 090-1234-5678, ${fakeEmail("buyer")}` }] } }
        : undefined,
    );
    const proposals = new ProposalStore(async () => undefined);
    // The fake "model" echoes the tool output it was given.
    const ai = new FakeAiProvider([{ text: "", toolCalls: [{ name: "get_dispute", input: { dispute_id: "PP-D-1" } }], after: (calls) => JSON.stringify(calls[0]!.output) }]);
    const res = await chat(ai, { ...TOOL_BASE, paypal: client, proposals, agentConfig: CONFIG, paymentPath: "invoice" }, [{ role: "user", content: "show PP-D-1" }], 500);
    expect(res.reply).toContain("Call me: [phone removed], [email removed]");
    expect(res.reply).not.toContain("090-1234-5678");
  });

  it("limit refusals come back to the model as tool errors (no proposal, no crash)", async () => {
    const { LimitError } = await import("../src/limits/limits.js");
    const proposals = new ProposalStore(async () => undefined);
    const refuse = () => {
      throw new LimitError(429, "proposal_rate_limited", "Too many new proposals", 60);
    };
    const tools = agentTools({ ...TOOL_BASE, paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "invoice", beforePropose: refuse });
    const out = await tools.find((t) => t.name === "send_invoice_reminder")!.execute({ invoice_id: "INV2-1" });
    expect(out).toEqual({ error: "Too many new proposals" });
    expect(proposals.list({ owner: "session-me" })).toEqual([]);
    const { client } = paypalWith(() => ({ json: {} }));
    const readTools = agentTools({ ...TOOL_BASE, paypal: client, proposals, agentConfig: CONFIG, paymentPath: "invoice", beforeRead: refuse });
    expect(await readTools.find((t) => t.name === "get_invoice")!.execute({ invoice_id: "INV2-1" })).toEqual({ error: "Too many new proposals" });
  });

  it("create_invoice takes a demo buyer alias, never an email address", async () => {
    const proposals = new ProposalStore(async () => undefined);
    const tool = agentTools({ ...TOOL_BASE, paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "invoice" }).find((t) => t.name === "create_invoice")!;
    const base = { item_title: "Tea bowl", price: { currency_code: "USD", value: "80.00" }, note: "Thanks for your order!" };
    expect(() => tool.inputSchema.parse({ ...base, buyer: fakeEmail("someone") })).toThrow();
    expect(() => tool.inputSchema.parse({ ...base, buyer_email: fakeEmail("someone") })).toThrow();
    expect(tool.description).not.toContain("@");
    const json = JSON.stringify((await import("zod")).z.toJSONSchema(tool.inputSchema, { io: "input" }));
    expect(json).toContain("Demo buyer 1");
    expect(json).not.toContain("@");

    const none = agentTools({ ...TOOL_BASE, buyers: new DemoBuyers([]), paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "invoice" }).find((t) => t.name === "create_invoice")!;
    expect(await none.execute({ ...base, buyer: "Demo buyer 1" })).toMatchObject({ error: expect.stringMatching(/No demo buyers/) });
  });

  it("offers create_order instead of create_invoice on the order path, and read tools explain missing PayPal", async () => {
    const proposals = new ProposalStore(async () => undefined);
    const names = agentTools({ ...TOOL_BASE, paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "order" }).map((t) => t.name);
    expect(names).toContain("create_order");
    expect(names).not.toContain("create_invoice");
    const list = agentTools({ ...TOOL_BASE, paypal: undefined, proposals, agentConfig: CONFIG, paymentPath: "order" }).find((t) => t.name === "list_invoices")!;
    expect(await list.execute({})).toMatchObject({ error: expect.stringMatching(/not configured/) });
  });
});
