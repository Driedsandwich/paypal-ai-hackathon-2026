import { describe, expect, it } from "vitest";
import { PayPalApiError } from "../src/paypal/client.js";
import type { InvoiceDraft } from "../src/paypal/types.js";
import { fakeEmail } from "./helpers/fake-fetch.js";
import { paypalError, paypalWith, SANDBOX, UUID_RE } from "./helpers/paypal.js";

const DRAFT: InvoiceDraft = {
  detail: { currency_code: "USD", invoice_number: "OKR-0001", note: "Thank you!" },
  primary_recipients: [{ billing_info: { email_address: fakeEmail("buyer") } }],
  items: [{ name: "Hand-thrown tea bowl", quantity: "1", unit_amount: { currency_code: "USD", value: "80.00" } }],
};

describe("Invoicing v2: create draft", () => {
  it("POSTs the invoice JSON with a fresh PayPal-Request-Id and reads the id from the body", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/invoicing/invoices` ? { status: 201, json: { id: "INV2-AAAA-BBBB", status: "DRAFT", detail: DRAFT.detail } } : undefined,
    );

    const created = await client.createDraftInvoice(DRAFT);
    await client.createDraftInvoice(DRAFT);

    expect(created.id).toBe("INV2-AAAA-BBBB");
    expect(created.invoice?.status).toBe("DRAFT");
    const [first, second] = apiCalls();
    expect(first!.method).toBe("POST");
    expect(first!.headers.Authorization).toBe("Bearer fake-access-token");
    expect(first!.headers["Content-Type"]).toBe("application/json");
    expect(first!.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(second!.headers["PayPal-Request-Id"]).not.toBe(first!.headers["PayPal-Request-Id"]);
    expect(JSON.parse(first!.body!)).toEqual(DRAFT);
  });

  it("accepts the minimal 201 answer that only has a self link", async () => {
    const { client } = paypalWith(() => ({
      status: 201,
      json: { rel: "self", href: `${SANDBOX}/v2/invoicing/invoices/INV2-SELF-LINK`, method: "GET" },
    }));
    const created = await client.createDraftInvoice(DRAFT, { requestId: "fixed-id" });
    expect(created).toEqual({ id: "INV2-SELF-LINK", href: `${SANDBOX}/v2/invoicing/invoices/INV2-SELF-LINK` });
  });

  it("maps a 422 to PayPalApiError with debug_id and issues", async () => {
    const { client } = paypalWith(() => ({
      status: 422,
      json: paypalError("UNPROCESSABLE_ENTITY", "dbg-422-abc", "CURRENCY_NOT_SUPPORTED"),
    }));
    const err = (await client.createDraftInvoice(DRAFT).catch((e: unknown) => e)) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.status).toBe(422);
    expect(err.debugId).toBe("dbg-422-abc");
    expect(err.toSafeJSON()).toEqual({
      message: "PayPal POST /v2/invoicing/invoices failed (422)",
      status: 422,
      name: "UNPROCESSABLE_ENTITY",
      debugId: "dbg-422-abc",
      issues: ["CURRENCY_NOT_SUPPORTED: CURRENCY_NOT_SUPPORTED description"],
    });
    expect(JSON.stringify(err.toSafeJSON())).not.toContain("Bearer");
  });

  it("falls back to the paypal-debug-id response header", async () => {
    const { client } = paypalWith(() => ({ status: 500, json: { name: "INTERNAL_SERVER_ERROR" }, headers: { "paypal-debug-id": "hdr-dbg-1" } }));
    const err = (await client.createDraftInvoice(DRAFT).catch((e: unknown) => e)) as PayPalApiError;
    expect(err.debugId).toBe("hdr-dbg-1");
  });
});

describe("Invoicing v2: send, remind, get, list, next number", () => {
  it("sends with the notification body and returns PayPal's link", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/invoicing/invoices/INV2-1/send`
        ? { json: { href: "https://www.sandbox.paypal.com/invoice/p/#INV2-1", rel: "payer-view", method: "GET" } }
        : undefined,
    );
    const link = await client.sendInvoice("INV2-1", { send_to_recipient: true, send_to_invoicer: true, subject: "Your invoice" });
    expect(link?.rel).toBe("payer-view");
    const call = apiCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(JSON.parse(call.body!)).toEqual({ send_to_recipient: true, send_to_invoicer: true, subject: "Your invoice" });
  });

  it("handles 202 Accepted from send", async () => {
    const { client } = paypalWith(() => ({ status: 202, json: { href: "https://example.invalid/x", rel: "self", method: "GET" } }));
    await expect(client.sendInvoice("INV2-1")).resolves.toMatchObject({ rel: "self" });
  });

  it("reminds (204 No Content) with a fresh request id", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/invoicing/invoices/INV2-1/remind` ? { status: 204 } : undefined,
    );
    await expect(client.remindInvoice("INV2-1", { subject: "Friendly reminder", note: "Hi!" })).resolves.toBeUndefined();
    const call = apiCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(JSON.parse(call.body!)).toEqual({ subject: "Friendly reminder", note: "Hi!" });
  });

  it("surfaces remind errors with debug_id", async () => {
    const { client } = paypalWith(() => ({ status: 422, json: paypalError("UNPROCESSABLE_ENTITY", "dbg-remind", "INVALID_INVOICE_STATUS") }));
    const err = (await client.remindInvoice("INV2-1").catch((e: unknown) => e)) as PayPalApiError;
    expect(err.debugId).toBe("dbg-remind");
  });

  it("gets one invoice with GET and no body or request id", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/invoicing/invoices/INV2%2F1` ? { json: { id: "INV2/1", status: "SENT", detail: { currency_code: "USD" } } } : undefined,
    );
    const inv = await client.getInvoice("INV2/1");
    expect(inv.status).toBe("SENT");
    const call = apiCalls()[0]!;
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.headers["PayPal-Request-Id"]).toBeUndefined();
  });

  it("lists invoices with page, page_size and total_required", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url.startsWith(`${SANDBOX}/v2/invoicing/invoices?`) ? { json: { total_items: 1, items: [{ id: "INV2-1", detail: { currency_code: "USD" } }] } } : undefined,
    );
    const list = await client.listInvoices({ page: 2, page_size: 10, total_required: true });
    expect(list.items?.[0]?.id).toBe("INV2-1");
    expect(apiCalls()[0]!.url).toBe(`${SANDBOX}/v2/invoicing/invoices?page=2&page_size=10&total_required=true`);
  });

  it("generates the next invoice number", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/invoicing/generate-next-invoice-number` ? { json: { invoice_number: "0042" } } : undefined,
    );
    await expect(client.generateNextInvoiceNumber()).resolves.toBe("0042");
    expect(apiCalls()[0]!.method).toBe("POST");
  });
});
