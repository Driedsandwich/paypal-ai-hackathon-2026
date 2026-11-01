import { describe, expect, it } from "vitest";
import { renderTextPdf } from "../src/docs/simple-pdf.js";
import { EventLog, WebhookDedup } from "../src/events/log.js";
import { TtlMap } from "../src/util/ttl-map.js";
import { AiLimiter } from "../src/limits/rate-limit.js";
import { DemoBuyers } from "../src/demo/buyers.js";
import { createPayPalExecutor, payerLinkOf } from "../src/proposals/actions.js";
import { OrderRegistry } from "../src/proposals/order-registry.js";
import { ReminderLedger } from "../src/proposals/reminder-ledger.js";
import { ProposalError, ProposalPolicyError, ProposalStore } from "../src/proposals/store.js";
import { fakeEmail } from "./helpers/fake-fetch.js";

const ME = { owner: "session-me" };
const CTX = { proposalId: "prop_1", owner: "session-me" };
const BUYERS = new DemoBuyers([fakeEmail("b1"), fakeEmail("b2")]);
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

describe("ProposalStore (approval gate)", () => {
  it("does nothing until approve, then runs the stored payload exactly once", async () => {
    const runs: unknown[] = [];
    const store = new ProposalStore(async (kind, payload) => {
      runs.push({ kind, payload });
      return { done: true };
    });
    const p = store.propose("send_dispute_message", "Reply to buyer", { disputeId: "D1", message: "hello" }, ME);
    expect(p.status).toBe("pending");
    expect(runs).toHaveLength(0);

    const done = await store.approve(p.id, ME.owner);
    expect(done.status).toBe("executed");
    expect(done.result).toEqual({ done: true });
    expect(runs).toEqual([{ kind: "send_dispute_message", payload: { disputeId: "D1", message: "hello" } }]);

    await expect(store.approve(p.id, ME.owner)).rejects.toMatchObject({ code: "not_pending" });
    expect(runs).toHaveLength(1);
  });

  it("refuses unknown and rejected proposals", async () => {
    let ran = false;
    const store = new ProposalStore(async () => void (ran = true));
    await expect(store.approve("nope", ME.owner)).rejects.toBeInstanceOf(ProposalError);
    const p = store.propose("accept_dispute_claim", "Accept claim", { disputeId: "D1", note: "n" }, ME);
    store.reject(p.id, ME.owner);
    await expect(store.approve(p.id, ME.owner)).rejects.toMatchObject({ code: "not_pending" });
    expect(() => store.reject(p.id, ME.owner)).toThrow(ProposalError);
    expect(ran).toBe(false);
  });

  it("freezes the payload so it cannot be changed after the seller saw it", () => {
    const payload = { disputeId: "D1", message: "original" };
    const store = new ProposalStore(async () => undefined);
    const p = store.propose("send_dispute_message", "t", payload, ME);
    payload.message = "changed later";
    expect((p.payload as typeof payload).message).toBe("original");
    expect(() => {
      (p.payload as typeof payload).message = "x";
    }).toThrow();
  });

  it("refuses a second approve while the first is still running", async () => {
    let release!: () => void;
    const store = new ProposalStore(() => new Promise((r) => (release = () => r("ok"))));
    const p = store.propose("capture_order", "Capture", { orderId: "O1" }, ME);
    const first = store.approve(p.id, ME.owner);
    await expect(store.approve(p.id, ME.owner)).rejects.toMatchObject({ code: "not_pending" });
    release();
    expect((await first).status).toBe("executed");
  });

  it("records failures with a safe error description", async () => {
    const store = new ProposalStore(
      async () => {
        throw new Error("boom");
      },
      { describeError: (e) => ({ message: (e as Error).message }) },
    );
    const p = store.propose("capture_order", "Capture", { orderId: "O1" }, ME);
    const res = await store.approve(p.id, ME.owner);
    expect(res.status).toBe("failed");
    expect(res.error).toEqual({ message: "boom" });
  });
});

describe("ProposalStore capacity (F4)", () => {
  it("refuses new proposals when full of pending ones instead of evicting them", () => {
    const store = new ProposalStore(async () => undefined, { max: 3 });
    const kept = [1, 2, 3].map((i) => store.propose("capture_order", `c${i}`, { orderId: `O${i}` }, ME));
    expect(() => store.propose("capture_order", "c4", { orderId: "O4" }, ME)).toThrow(expect.objectContaining({ code: "store_full" }));
    for (const p of kept) expect(store.get(p.id, ME.owner)?.status).toBe("pending");
  });

  it("drops the oldest finished proposals to make room, keeping 'unknown' ones longest", async () => {
    const store = new ProposalStore(
      async (_k, payload) => {
        if ((payload as { orderId: string }).orderId === "U") throw new Error("timeout");
        return "ok";
      },
      { max: 3, isUnknownOutcome: () => true },
    );
    const unknown = store.propose("capture_order", "u", { orderId: "U" }, ME);
    await store.approve(unknown.id, ME.owner);
    const done = store.propose("capture_order", "d", { orderId: "D" }, ME);
    await store.approve(done.id, ME.owner);
    const waiting = store.propose("capture_order", "w", { orderId: "W" }, ME);
    store.propose("capture_order", "new", { orderId: "N" }, ME);
    expect(store.get(done.id, ME.owner)).toBeUndefined();
    expect(store.get(unknown.id, ME.owner)?.status).toBe("unknown");
    expect(store.get(waiting.id, ME.owner)?.status).toBe("pending");
  });

  it("caps pending proposals per client address", () => {
    const store = new ProposalStore(async () => undefined, { maxPendingPerAddress: 2 });
    store.propose("capture_order", "a", {}, { ...ME, address: "203.0.113.7" });
    store.propose("capture_order", "b", {}, { owner: "other-session", address: "203.0.113.7" });
    expect(() => store.propose("capture_order", "c", {}, { owner: "third", address: "203.0.113.7" })).toThrow(expect.objectContaining({ code: "too_many_pending" }));
    expect(store.propose("capture_order", "d", {}, { ...ME, address: "198.51.100.1" }).status).toBe("pending");
  });

  it("pending proposals expire after 24 hours and cannot run", async () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    let ran = false;
    const store = new ProposalStore(async () => void (ran = true), { now: () => new Date(now) });
    const p = store.propose("capture_order", "c", { orderId: "O" }, ME);
    now += 24 * 3_600_000 + 1;
    expect(store.list({ owner: ME.owner })[0]).toMatchObject({ status: "expired", error: { message: expect.stringMatching(/expired/) } });
    await expect(store.approve(p.id, ME.owner)).rejects.toMatchObject({ code: "not_pending" });
    expect(ran).toBe(false);
  });
});

describe("PayPal executor", () => {
  it("create_and_send_invoice: next number, create draft, then send", async () => {
    const { client, apiCalls } = paypalWith((c) => {
      if (c.url.endsWith("/generate-next-invoice-number")) return { json: { invoice_number: "0007" } };
      if (c.url === `${SANDBOX}/v2/invoicing/invoices`) return { status: 201, json: { id: "INV2-7", status: "DRAFT" } };
      if (c.url.endsWith("/INV2-7/send")) return { json: { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-7", rel: "payer-view" } };
      return undefined;
    });
    const exec = createPayPalExecutor(() => client, { buyers: BUYERS });
    const result = await exec(
      "create_and_send_invoice",
      {
        recipient_alias: "Demo buyer 2",
        invoice: {
          detail: { currency_code: "USD" },
          items: [{ name: "Tea bowl", quantity: "1", unit_amount: { currency_code: "USD", value: "80.00" } }],
        },
        notification: { send_to_recipient: true },
      },
      CTX,
    );
    expect(result).toEqual({ invoiceId: "INV2-7", invoiceNumber: "0007", recipient: "Demo buyer 2", payerLink: "https://www.sandbox.paypal.com/invoice/p/#INV2-7" });
    expect(apiCalls().map((c) => c.url.replace(SANDBOX, ""))).toEqual([
      "/v2/invoicing/generate-next-invoice-number",
      "/v2/invoicing/invoices",
      "/v2/invoicing/invoices/INV2-7/send",
    ]);
    const sent = JSON.parse(apiCalls()[1]!.body!);
    expect(sent.detail.invoice_number).toBe("0007");
    // The alias is resolved to the allowlisted sandbox email only now, at execution.
    expect(sent.primary_recipients).toEqual([{ billing_info: { email_address: fakeEmail("b2") } }]);
  });

  it("create_payment_link returns the payer-action link", async () => {
    const { client } = paypalWith(() => ({
      status: 200,
      json: { id: "O-9", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=O-9" }] },
    }));
    const orders = new OrderRegistry();
    const exec = createPayPalExecutor(() => client, { buyers: BUYERS, orders });
    await expect(
      exec("create_payment_link", { recipient_alias: "Demo buyer 1", order: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] } }, CTX),
    ).resolves.toEqual({ orderId: "O-9", status: "PAYER_ACTION_REQUIRED", recipient: "Demo buyer 1", payerLink: "https://www.sandbox.paypal.com/checkoutnow?token=O-9" });
    expect(orders.get("O-9")).toEqual({ owner: "session-me" });
    expect(payerLinkOf([{ rel: "approve", href: "a" }])).toBe("a");
  });

  it("provide_dispute_evidence decodes base64 attachments into evidence-file parts", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.method === "GET" ? { json: { dispute_id: "D1", links: [{ rel: "provide_evidence", href: `${SANDBOX}/v1/customer/disputes/D1/provide-evidence`, method: "POST" }] } } : { json: { links: [] } },
    );
    const exec = createPayPalExecutor(() => client, { buyers: BUYERS });
    await exec(
      "provide_dispute_evidence",
      {
        disputeId: "D1",
        evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", notes: "n" }],
        attachments: [{ name: "invoice.pdf", contentType: "application/pdf", base64: Buffer.from("%PDF-1.4").toString("base64") }],
      },
      CTX,
    );
    expect(apiCalls().map((c) => c.method)).toEqual(["GET", "POST"]); // re-check, then write
    expect(apiCalls()[1]!.form?.[1]).toEqual({ name: "evidence-file", value: "%PDF-1.4", filename: "invoice.pdf", type: "application/pdf" });
  });
});

describe("execution allowlist (F1)", () => {
  const invoice = { detail: { currency_code: "USD" }, items: [{ name: "Tea bowl", quantity: "1", unit_amount: { currency_code: "USD", value: "80.00" } }] };
  const order = { intent: "CAPTURE" as const, purchase_units: [{ amount: { currency_code: "USD", value: "1.00" } }] };

  it("refuses recipients that are not demo buyers, before any PayPal call", async () => {
    const { client, apiCalls } = paypalWith(() => ({ json: {} }));
    const exec = createPayPalExecutor(() => client, { buyers: BUYERS });
    const bad: Array<[Parameters<typeof exec>[0], unknown]> = [
      ["create_and_send_invoice", { recipient_alias: "Demo buyer 7", invoice, notification: {} }],
      ["create_and_send_invoice", { recipient_alias: "Demo buyer 1", invoice: { ...invoice, primary_recipients: [{ billing_info: { email_address: fakeEmail("x") } }] }, notification: {} }],
      ["create_and_send_invoice", { recipient_alias: "Demo buyer 1", invoice, notification: { additional_recipients: [fakeEmail("x")] } }],
      ["create_payment_link", { recipient_alias: "nobody", order }],
      ["create_payment_link", { recipient_alias: "Demo buyer 1", order: { ...order, payment_source: { paypal: { email_address: fakeEmail("x") } } } }],
      ["seed_demo_data", { invoices: [{ recipient_alias: "Demo buyer 1", invoice, notification: {} }, { recipient_alias: "Demo buyer 9", invoice, notification: {} }] }],
    ];
    for (const [kind, payload] of bad) await expect(exec(kind, payload, CTX)).rejects.toBeInstanceOf(ProposalPolicyError);
    expect(apiCalls()).toHaveLength(0);
    const none = createPayPalExecutor(() => client, { buyers: new DemoBuyers([]) });
    await expect(none("create_payment_link", { recipient_alias: "Demo buyer 1", order }, CTX)).rejects.toThrow(/No demo buyers/);
  });

  it("aliases are case-insensitive and duplicates in DEMO_BUYER_EMAILS collapse", () => {
    const buyers = new DemoBuyers([fakeEmail("b1"), ` ${fakeEmail("B1")} `, fakeEmail("b2")]);
    expect(buyers.aliases).toEqual(["Demo buyer 1", "Demo buyer 2"]);
    expect(buyers.resolve("  demo   BUYER 2 ")?.email).toBe(fakeEmail("b2"));
    expect(buyers.isAllowed(fakeEmail("B2"))).toBe(true);
    expect(buyers.aliasOf(fakeEmail("b1"))).toBe("Demo buyer 1");
    expect(buyers.publicList()[0]).toEqual({ alias: "Demo buyer 1", email: "b***@example.com" });
  });

  it("store.get/list/approve/reject only work for the owner", async () => {
    const store = new ProposalStore(async () => "ran");
    const p = store.propose("capture_order", "Capture", { orderId: "O1" }, ME);
    expect(store.get(p.id, "someone-else")).toBeUndefined();
    expect(store.list({ owner: "someone-else" })).toEqual([]);
    await expect(store.approve(p.id, "someone-else")).rejects.toMatchObject({ code: "not_found" });
    expect(() => store.reject(p.id, "someone-else")).toThrow(ProposalError);
    expect(store.get(p.id, ME.owner)?.status).toBe("pending");
    expect(() => store.propose("capture_order", "x", {}, { owner: "" })).toThrow(/owner/);
  });
});

describe("standard reminders (F10)", () => {
  it("the ledger allows 2 reminders per invoice per UTC day", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const ledger = new ReminderLedger(2, () => now);
    expect([ledger.reserve("INV2-A"), ledger.reserve("INV2-A"), ledger.reserve("INV2-A")]).toEqual([true, true, false]);
    expect(ledger.remaining("INV2-B")).toBe(2);
    ledger.release("INV2-A");
    expect(ledger.remaining("INV2-A")).toBe(1);
    now = Date.parse("2026-11-02T00:00:01Z");
    expect(ledger.remaining("INV2-A")).toBe(2);
  });

  it("sends only the flags, and a third reminder the same day becomes obsolete without calling PayPal", async () => {
    const { client, apiCalls } = paypalWith((c) => (c.url.endsWith("/remind") ? { status: 204 } : undefined));
    const reminders = new ReminderLedger();
    const store = new ProposalStore(createPayPalExecutor(() => client, { buyers: BUYERS, reminders }));
    const payload = { invoiceId: "INV2-A", notification: { send_to_recipient: true, send_to_invoicer: true } };
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await store.approve(store.propose("send_invoice_reminder", "Send PayPal's standard reminder", payload, ME).id, ME.owner));
    expect(runs.map((r) => r.status)).toEqual(["executed", "executed", "obsolete"]);
    expect((runs[2]!.error as { message: string }).message).toMatch(/at most 2 reminders per invoice per day/);
    expect(apiCalls()).toHaveLength(2);
    expect(JSON.parse(apiCalls()[0]!.body!)).toEqual({ send_to_recipient: true, send_to_invoicer: true });
  });

  it("a reminder PayPal refuses does not use up the daily allowance", async () => {
    const { client } = paypalWith(() => ({ status: 422, json: { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg" } }));
    const reminders = new ReminderLedger();
    const store = new ProposalStore(createPayPalExecutor(() => client, { buyers: BUYERS, reminders }));
    const p = await store.approve(store.propose("send_invoice_reminder", "r", { invoiceId: "INV2-A", notification: { send_to_recipient: true } }, ME).id, ME.owner);
    expect(p.status).toBe("failed");
    expect(reminders.remaining("INV2-A")).toBe(2);
  });
});

describe("AiLimiter", () => {
  it("allows 20 calls per IP per 10 minutes, then refuses with a retry time", () => {
    let now = Date.parse("2026-11-01T10:00:00Z");
    const limiter = new AiLimiter({ perIpMax: 20, windowMs: 600_000, dailyCap: 300 }, () => now);
    for (let i = 0; i < 20; i++) expect(limiter.take("1.2.3.4").ok).toBe(true);
    const refused = limiter.take("1.2.3.4");
    expect(refused).toMatchObject({ ok: false, reason: "per_ip", retryAfterSeconds: 600 });
    expect(limiter.take("5.6.7.8").ok).toBe(true); // other IPs unaffected
    now += 600_001;
    expect(limiter.take("1.2.3.4").ok).toBe(true);
  });

  it("enforces the global daily cap and resets at 00:00 UTC", () => {
    let now = Date.parse("2026-11-01T23:59:00Z");
    const limiter = new AiLimiter({ perIpMax: 100, windowMs: 600_000, dailyCap: 3 }, () => now);
    for (let i = 0; i < 3; i++) expect(limiter.take(`ip${i}`).ok).toBe(true);
    const refused = limiter.take("ip9");
    expect(refused).toMatchObject({ ok: false, reason: "daily_cap", retryAfterSeconds: 60 });
    expect(refused.ok ? "" : refused.message).toMatch(/daily AI limit/);
    now = Date.parse("2026-11-02T00:00:01Z");
    expect(limiter.take("ip9").ok).toBe(true);
  });
});

describe("EventLog", () => {
  it("routes the four event types, ignores others, and de-duplicates by id", () => {
    const log = new EventLog(10, () => new Date("2026-11-01T00:00:00Z"));
    log.record({ id: "E1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-1", detail: { invoice_number: "0001" } } } });
    log.record({ id: "E2", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1", amount: { value: "80.00", currency_code: "USD" } } });
    log.record({ id: "E3", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" } });
    log.record({ id: "E4", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: { dispute_id: "PP-D-1", status: "UNDER_REVIEW" } });
    log.record({ id: "E5", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} });
    expect(log.record({ id: "E1", event_type: "INVOICING.INVOICE.PAID" })).toBeUndefined();

    expect(log.list().map((e) => [e.id, e.category, e.resourceId])).toEqual([
      ["E5", "ignored", undefined],
      ["E4", "dispute", "PP-D-1"],
      ["E3", "dispute", "PP-D-1"],
      ["E2", "payment", "CAP-1"],
      ["E1", "invoice", "INV2-1"],
    ]);
    expect(log.list({ category: "dispute" }).map((e) => e.summary)).toEqual([
      "Dispute PP-D-1 updated, status UNDER_REVIEW",
      "Dispute PP-D-1 opened (MERCHANDISE_OR_SERVICE_NOT_RECEIVED)",
    ]);
    expect(log.list()[3]!.summary).toBe("Payment CAP-1 completed (80.00 USD)");
  });

  it("is bounded", () => {
    const log = new EventLog(2);
    for (const id of ["a", "b", "c"]) log.record({ id, event_type: "PAYMENT.CAPTURE.COMPLETED" });
    expect(log.list().map((e) => e.id)).toEqual(["c", "b"]);
  });

  it("keeps de-duplicating after an event scrolled out of the display log, for 3 days", () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const log = new EventLog(2, () => new Date(now));
    log.record({ id: "E1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
    for (let i = 0; i < 250; i++) log.record({ id: `other-${i}`, event_type: "PAYMENT.CAPTURE.COMPLETED" });
    expect(log.list().map((e) => e.id)).not.toContain("E1");
    expect(log.record({ id: "E1", event_type: "PAYMENT.CAPTURE.COMPLETED" })).toBeUndefined();
    expect(log.hasSeen("E1")).toBe(true);
    now += 3 * 86_400_000 + 1;
    expect(log.hasSeen("E1")).toBe(false);
    expect(log.record({ id: "E1", event_type: "PAYMENT.CAPTURE.COMPLETED" })?.id).toBe("E1");
  });

  it("ignores events without an id", () => {
    const log = new EventLog(10);
    expect(log.record({ id: "", event_type: "PAYMENT.CAPTURE.COMPLETED" })).toBeUndefined();
    expect(log.record({ event_type: "PAYMENT.CAPTURE.COMPLETED" } as never)).toBeUndefined();
    expect(log.list()).toEqual([]);
  });

  it("the dedup cache is bounded", () => {
    const dedup = new WebhookDedup({ max: 3 });
    for (const id of ["a", "b", "c", "d"]) dedup.remember(id);
    expect(["a", "b", "c", "d"].map((id) => dedup.seen(id))).toEqual([false, true, true, true]);
  });
});

describe("TtlMap", () => {
  it("expires entries and stays within its maximum size", () => {
    let now = 0;
    const m = new TtlMap<string, number>({ ttlMs: 100, max: 2, now: () => now });
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    expect([m.get("a"), m.get("b"), m.get("c"), m.size]).toEqual([undefined, 2, 3, 2]);
    now = 101;
    expect(m.get("b")).toBeUndefined();
    m.set("d", 4, 1000);
    now = 500;
    expect(m.get("d")).toBe(4);
  });
});

describe("simple PDF", () => {
  it("writes a valid-looking single-page PDF with escaped ASCII text", () => {
    const text = Buffer.from(renderTextPdf("Invoice (summary)", ["Item: tea bowl", "日本"])).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("(Invoice \\(summary\\)) Tj");
    expect(text).toContain("(??) Tj");
    const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(xref, xref + 4)).toBe("xref");
  });
});
