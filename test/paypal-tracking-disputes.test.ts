import { describe, expect, it } from "vitest";
import { carrierFor } from "../src/paypal/carriers.js";
import { PayPalApiError } from "../src/paypal/client.js";
import { paypalError, paypalWith, SANDBOX, UUID_RE } from "./helpers/paypal.js";

describe("carrier mapping", () => {
  it("maps Japanese carriers to each API's enum and falls back to OTHER", () => {
    expect(carrierFor("Japan Post", "orders")).toEqual({ carrier: "JPN_JAPAN_POST" });
    expect(carrierFor("日本郵便", "shipping")).toEqual({ carrier: "JPN_JAPAN_POST" });
    expect(carrierFor("Yamato", "orders")).toEqual({ carrier: "YAMATO" });
    expect(carrierFor("クロネコ", "shipping")).toEqual({ carrier: "JP_KURO_NEKO_YAMATO_UNYUU" });
    expect(carrierFor("Sagawa", "shipping")).toEqual({ carrier: "JPN_SAGAWA" });
    expect(carrierFor("ヤマト運輸", "disputes")).toEqual({ carrier: "JPN_YAMATO" });
    expect(carrierFor("Japan Post", "disputes")).toEqual({ carrier: "JPN_JAPAN_POST" });
    expect(carrierFor("FedEx", "orders")).toEqual({ carrier: "FEDEX" });
    expect(carrierFor("Local courier", "orders")).toEqual({ carrier: "OTHER", carrier_name_other: "Local courier" });
    expect(() => carrierFor("  ", "orders")).toThrow();
  });
});

describe("Orders v2 tracking and order calls", () => {
  it("POSTs order_tracker_request to /v2/checkout/orders/{id}/track", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v2/checkout/orders/ORDER-1/track` ? { status: 201, json: { id: "ORDER-1", status: "COMPLETED" } } : undefined,
    );
    await client.addOrderTracking("ORDER-1", {
      capture_id: "CAPTURE-1",
      tracking_number: "EJ123456789JP",
      carrier: "JPN_JAPAN_POST",
      notify_payer: true,
    });
    const call = apiCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(JSON.parse(call.body!)).toEqual({
      capture_id: "CAPTURE-1",
      tracking_number: "EJ123456789JP",
      carrier: "JPN_JAPAN_POST",
      notify_payer: true,
    });
  });

  it("maps a track error with debug_id", async () => {
    const { client } = paypalWith(() => ({ status: 422, json: paypalError("UNPROCESSABLE_ENTITY", "dbg-track", "CAPTURE_ID_NOT_FOUND") }));
    const err = (await client
      .addOrderTracking("ORDER-1", { capture_id: "X", tracking_number: "1", carrier: "UPS" })
      .catch((e: unknown) => e)) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.debugId).toBe("dbg-track");
  });

  it("creates orders with a generated request id and gets an order", async () => {
    const { client, apiCalls } = paypalWith((c) => {
      if (c.url === `${SANDBOX}/v2/checkout/orders` && c.method === "POST") return { status: 201, json: { id: "O-1", status: "PAYER_ACTION_REQUIRED" } };
      if (c.url === `${SANDBOX}/v2/checkout/orders/O-1` && c.method === "GET") return { json: { id: "O-1", status: "APPROVED" } };
      return undefined;
    });
    await client.createOrder({ intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "5.00" } }] });
    const order = await client.getOrder("O-1");
    expect(order.status).toBe("APPROVED");
    expect(apiCalls()[0]!.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(apiCalls()[1]!.headers["PayPal-Request-Id"]).toBeUndefined();
  });
});

describe("Add Tracking v1 trackers-batch", () => {
  const tracker = {
    transaction_id: "8MC585209K746392H",
    tracking_number: "EJ123456789JP",
    status: "SHIPPED" as const,
    carrier: "JPN_JAPAN_POST",
    notify_buyer: true,
  };

  it("POSTs { trackers: [...] } with a request id", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v1/shipping/trackers-batch`
        ? { json: { tracker_identifiers: [{ transaction_id: tracker.transaction_id, tracking_number: tracker.tracking_number }], errors: [] } }
        : undefined,
    );
    const res = await client.addTrackersBatch([tracker]);
    expect(res.tracker_identifiers).toHaveLength(1);
    const call = apiCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(JSON.parse(call.body!)).toEqual({ trackers: [tracker] });
  });

  it("raises per-tracker errors that come back with HTTP 200", async () => {
    const { client } = paypalWith(() => ({
      json: { tracker_identifiers: [], errors: [{ name: "RESOURCE_NOT_FOUND", message: "Transaction not found", debug_id: "dbg-batch" }] },
    }));
    const err = (await client.addTrackersBatch([tracker]).catch((e: unknown) => e)) as PayPalApiError;
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.debugId).toBe("dbg-batch");
    expect(err.errorName).toBe("RESOURCE_NOT_FOUND");
  });

  it("rejects empty batches without calling PayPal", async () => {
    const { client, apiCalls } = paypalWith(() => undefined);
    await expect(client.addTrackersBatch([])).rejects.toThrow(/1 to 20/);
    expect(apiCalls()).toHaveLength(0);
  });
});

describe("Customer Disputes v1", () => {
  it("lists disputes with query params and gets one", async () => {
    const { client, apiCalls } = paypalWith((c) => {
      if (c.url.startsWith(`${SANDBOX}/v1/customer/disputes?`)) return { json: { items: [{ dispute_id: "PP-D-1", status: "WAITING_FOR_SELLER_RESPONSE" }] } };
      if (c.url === `${SANDBOX}/v1/customer/disputes/PP-D-1`) return { json: { dispute_id: "PP-D-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" } };
      return undefined;
    });
    const list = await client.listDisputes({ dispute_state: "REQUIRED_ACTION", page_size: 20 });
    expect(list.items?.[0]?.dispute_id).toBe("PP-D-1");
    expect(apiCalls()[0]!.url).toBe(`${SANDBOX}/v1/customer/disputes?dispute_state=REQUIRED_ACTION&page_size=20`);
    const d = await client.getDispute("PP-D-1");
    expect(d.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    expect(apiCalls()[1]!.method).toBe("GET");
  });

  it("provides evidence as multipart: JSON `input` part plus `evidence-file` parts", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v1/customer/disputes/PP-D-1/provide-evidence` ? { json: { links: [{ href: "x", rel: "self" }] } } : undefined,
    );
    const evidences = [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: { tracking_info: [{ carrier_name: "OTHER", carrier_name_other: "Japan Post", tracking_number: "EJ123456789JP" }] },
        notes: "Shipped on 2026-10-20 with Japan Post EMS.",
      },
    ];
    await client.provideDisputeEvidence("PP-D-1", evidences, [
      { name: "invoice.png", contentType: "image/png", data: new TextEncoder().encode("PNGDATA") },
    ]);
    const call = apiCalls()[0]!;
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBeUndefined(); // fetch sets multipart boundary itself
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    expect(call.form).toEqual([
      { name: "input", value: JSON.stringify({ evidences }), type: "application/json" },
      { name: "evidence-file", value: "PNGDATA", filename: "invoice.png", type: "image/png" },
    ]);
  });

  it("sends a message as JSON { message }", async () => {
    const { client, apiCalls } = paypalWith((c) =>
      c.url === `${SANDBOX}/v1/customer/disputes/PP-D-1/send-message` ? { json: { links: [] } } : undefined,
    );
    await client.sendDisputeMessage("PP-D-1", "Hello, the parcel is on its way.");
    const call = apiCalls()[0]!;
    expect(JSON.parse(call.body!)).toEqual({ message: "Hello, the parcel is on its way." });
    expect(call.headers["PayPal-Request-Id"]).toMatch(UUID_RE);
    await expect(client.sendDisputeMessage("PP-D-1", "x".repeat(2001))).rejects.toThrow(/2000/);
  });

  it("accepts a claim with { note } and maps errors with debug_id", async () => {
    let fail = false;
    const { client, apiCalls } = paypalWith((c) => {
      if (!c.url.endsWith("/accept-claim")) return undefined;
      return fail ? { status: 422, json: paypalError("UNPROCESSABLE_ENTITY", "dbg-accept", "NOT_ALLOWED") } : { json: { links: [] } };
    });
    await client.acceptDisputeClaim("PP-D-1", "Refunding in full. Sorry for the trouble.");
    expect(JSON.parse(apiCalls()[0]!.body!)).toEqual({ note: "Refunding in full. Sorry for the trouble." });
    fail = true;
    const err = (await client.acceptDisputeClaim("PP-D-1", "n").catch((e: unknown) => e)) as PayPalApiError;
    expect(err.debugId).toBe("dbg-accept");
  });
});
