import { describe, expect, it } from "vitest";
import { FakeAiProvider } from "../src/ai/index.js";
import { AgentOutputError } from "../src/agent/json-task.js";
import { EvidenceInputSchema, EvidencePackAiSchema } from "../src/agent/schemas.js";
import { claimsMissingAttachment, repairSendableText, sendableTextProblems } from "../src/agent/sendable-text.js";
import { Agent, type AgentConfig } from "../src/agent/tasks.js";

// Pass 5, item 2: the hosted demo's AI wrote seller to-dos into the evidence notes and claimed
// an attachment that did not exist; both went to PayPal unchanged.

const CONFIG: AgentConfig = { fxJpyPerUsd: 150, maxOutputTokens: 800, publicBaseUrl: "http://localhost:3000/" };

const CASE = {
  dispute_id: "PP-R-ABC-12345678",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "CHARGEBACK",
  amount: { currency_code: "USD", value: "80.00" },
  allowed_actions: ["provide_evidence"],
};
const TRACKING = { carrier: "Japan Post", tracking_number: "EJ123456789JP", shipped_date: "2026-10-17" };
const INVOICE = { invoice_id: "INV2-AAAA", invoice_number: "0001", status: "PAID", amount: { currency_code: "USD", value: "80.00" }, items: [{ name: "Tea bowl", quantity: "1" }] };

/** An answer shaped like the one seen on the hosted demo on 2026-11-01. */
const HOSTED_ANSWER = {
  summary: "The buyer says the tea bowl did not arrive. It was shipped with Japan Post, tracking EJ123456789JP.",
  timeline: [{ date: "2026-10-17", event: "Shipped with Japan Post", source: "tracking" }],
  reply_draft:
    "Hello, I am sorry the parcel has not reached you yet. It was shipped with Japan Post, tracking EJ123456789JP. [Seller: add the expected delivery date if you know it] Please check the tracking page.",
  evidence_notes:
    "The item was shipped with Japan Post on 2026-10-17, tracking number EJ123456789JP. [Seller: attach the Japan Post receipt and a tracking screenshot before submitting.]\nAttached: proof of shipment and Japan Post tracking information.",
  recommended_action: "provide_evidence",
  missing_information: [],
};

const fake = (answer: object) => new FakeAiProvider([JSON.stringify(answer)], { record: true });

describe("sendable texts (evidence notes, reply draft)", () => {
  it("removes bracketed seller instructions and a claimed attachment that does not exist, and lists them as to-dos", async () => {
    const input = EvidenceInputSchema.parse({ dispute: CASE, tracking: TRACKING });
    const pack = await new Agent(fake(HOSTED_ANSWER), CONFIG).disputeEvidencePack(input);

    expect(pack.attachments).toEqual([]);
    const notes = pack.evidence_payload.evidences[0]!.notes!;
    expect(notes).toBe("The item was shipped with Japan Post on 2026-10-17, tracking number EJ123456789JP.");
    expect(notes).not.toMatch(/\[|Seller:|Attached/);
    expect(pack.message_payload.message).toBe("Hello, I am sorry the parcel has not reached you yet. It was shipped with Japan Post, tracking EJ123456789JP. Please check the tracking page.");
    expect(pack.evidence_notes).toBe(notes);
    expect(pack.reply_draft).toBe(pack.message_payload.message);

    const todo = pack.missing_information.join("\n");
    expect(todo).toContain("Seller: attach the Japan Post receipt and a tracking screenshot before submitting.");
    expect(todo).toContain("Seller: add the expected delivery date if you know it");
    expect(todo).toMatch(/Attached: proof of shipment/);
    expect(pack.unverified_facts).toEqual([]);
  });

  it("tells the model what is attached and that seller to-dos belong in missing_information", async () => {
    const ai = fake(HOSTED_ANSWER);
    await new Agent(ai, CONFIG).disputeEvidencePack(EvidenceInputSchema.parse({ dispute: CASE, tracking: TRACKING, invoice: INVOICE }));
    const req = ai.calls[0]!;
    const system = req.messages.find((m) => m.role === "system")!.content;
    expect(system).toMatch(/missing_information, never in reply_draft or evidence_notes/);
    expect(system).toMatch(/Only the files listed in attachments are attached/);
    const user = req.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain('"attachments":[{"name":"invoice-0001.pdf"');
    // The JSON Schema the model sees carries the same rule.
    expect(user).toContain("Seller to-dos go here, never in reply_draft or evidence_notes");
    expect(EvidencePackAiSchema.shape.evidence_notes.description).toMatch(/no instructions to the seller/);
  });

  it("keeps a true attachment claim: the invoice summary PDF is attached", async () => {
    const answer = { ...HOSTED_ANSWER, reply_draft: "Hello, your parcel was shipped with Japan Post, tracking EJ123456789JP.", evidence_notes: "Shipped with Japan Post, tracking EJ123456789JP. Attached: the invoice summary with the tracking number." };
    const pack = await new Agent(fake(answer), CONFIG).disputeEvidencePack(EvidenceInputSchema.parse({ dispute: CASE, tracking: TRACKING, invoice: INVOICE }));
    expect(pack.attachments.map((a) => a.name)).toEqual(["invoice-0001.pdf"]);
    expect(pack.evidence_notes).toBe(answer.evidence_notes);
    expect(pack.missing_information).toEqual([]);
  });

  it("still removes a claim of files that are not among the attachments", () => {
    const attached = [{ name: "invoice-0001.pdf", description: "Invoice summary generated from PayPal invoice data, with the carrier and tracking number" }];
    expect(claimsMissingAttachment("Attached: proof of shipment and Japan Post tracking information.", attached)).toBe(true);
    expect(claimsMissingAttachment("Please find the attached receipt.", attached)).toBe(true);
    expect(claimsMissingAttachment("Attached is the invoice summary.", attached)).toBe(false);
    expect(claimsMissingAttachment("Attached is the invoice summary.", [])).toBe(true);
    expect(claimsMissingAttachment("The parcel was shipped on time.", [])).toBe(false);
  });

  it("finds (Seller: …) notes and placeholders too", () => {
    const r = repairSendableText("Your parcel is on its way (Seller: confirm the date). Tracking: [tracking number].", []);
    expect(r.text).toBe("Your parcel is on its way. Tracking:.");
    expect(r.removed).toEqual(["To do: tracking number", "To do: Seller: confirm the date"]);
    expect(sendableTextProblems("Fine text.", [])).toEqual([]);
    expect(sendableTextProblems("Text [Seller: add photo]", []).length).toBe(1);
  });

  it("refuses an answer whose text is only instructions", async () => {
    const answer = { ...HOSTED_ANSWER, evidence_notes: "[Seller: write the notes for PayPal here, with the tracking number]" };
    await expect(new Agent(fake(answer), CONFIG).disputeEvidencePack(EvidenceInputSchema.parse({ dispute: CASE, tracking: TRACKING }))).rejects.toBeInstanceOf(AgentOutputError);
  });
});
