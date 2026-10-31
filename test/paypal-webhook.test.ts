import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PayPalClient } from "../src/paypal/client.js";
import { handlePayPalWebhook, type PayPalWebhookEvent } from "../src/paypal/webhook.js";
import { createApp } from "../src/server.js";
import { createFakeFetch, FAKE_CONFIG, type RecordedCall } from "./helpers/fake-fetch.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";

const EVENT = {
  id: "WH-TEST-EVENT-1",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: { id: "CAPTURE-1", status: "COMPLETED" },
};

const HEADERS = {
  "paypal-auth-algo": "SHA256withRSA",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
  "paypal-transmission-id": "TRANSMISSION-TEST-1",
  "paypal-transmission-sig": "fake-signature",
  "paypal-transmission-time": "2026-10-31T00:00:00Z",
};

function paypalWithVerification(status: "SUCCESS" | "FAILURE") {
  const fake = createFakeFetch((c: RecordedCall) => {
    if (c.url.endsWith("/v1/oauth2/token")) {
      return { json: { access_token: "fake-access-token", token_type: "Bearer", expires_in: 3600 } };
    }
    if (c.url === `${SANDBOX}/v1/notifications/verify-webhook-signature`) {
      return { json: { verification_status: status } };
    }
    return undefined;
  });
  return { ...fake, client: new PayPalClient({ config: FAKE_CONFIG, fetch: fake.fetch }) };
}

describe("handlePayPalWebhook", () => {
  it("verifies through the PayPal API and passes the event on", async () => {
    const { client, calls } = paypalWithVerification("SUCCESS");
    const received: PayPalWebhookEvent[] = [];

    const res = await handlePayPalWebhook(
      { headers: HEADERS, rawBody: JSON.stringify(EVENT) },
      { webhookId: FAKE_CONFIG.webhookId, verify: (r) => client.verifyWebhookSignature(r), onEvent: (e) => void received.push(e) },
    );

    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(received.map((e) => e.id)).toEqual(["WH-TEST-EVENT-1"]);
    const verifyCall = calls.find((c) => c.url.endsWith("/verify-webhook-signature"))!;
    expect(verifyCall.headers.Authorization).toBe("Bearer fake-access-token");
    expect(JSON.parse(verifyCall.body!)).toEqual({
      auth_algo: "SHA256withRSA",
      cert_url: HEADERS["paypal-cert-url"],
      transmission_id: "TRANSMISSION-TEST-1",
      transmission_sig: "fake-signature",
      transmission_time: "2026-10-31T00:00:00Z",
      webhook_id: "TEST-WEBHOOK-ID",
      webhook_event: EVENT,
    });
  });

  it("rejects when PayPal says the signature is not valid", async () => {
    const { client } = paypalWithVerification("FAILURE");
    let called = false;
    const res = await handlePayPalWebhook(
      { headers: HEADERS, rawBody: JSON.stringify(EVENT) },
      { webhookId: FAKE_CONFIG.webhookId, verify: (r) => client.verifyWebhookSignature(r), onEvent: () => void (called = true) },
    );
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("rejects missing headers and bad JSON without calling PayPal", async () => {
    let verifyCalls = 0;
    const deps = { webhookId: "W", verify: async () => (verifyCalls++, true) };
    const { "paypal-transmission-sig": _omit, ...partial } = HEADERS;

    expect((await handlePayPalWebhook({ headers: partial, rawBody: JSON.stringify(EVENT) }, deps)).status).toBe(400);
    expect((await handlePayPalWebhook({ headers: HEADERS, rawBody: "{not json" }, deps)).status).toBe(400);
    expect(verifyCalls).toBe(0);
  });

  it("returns 500 when no webhook ID is configured", async () => {
    const res = await handlePayPalWebhook({ headers: HEADERS, rawBody: "{}" }, { webhookId: undefined, verify: async () => true });
    expect(res.status).toBe(500);
  });

  it("returns 502 when the verification call fails", async () => {
    const res = await handlePayPalWebhook(
      { headers: HEADERS, rawBody: JSON.stringify(EVENT) },
      { webhookId: "W", verify: async () => Promise.reject(new Error("network")) },
    );
    expect(res.status).toBe(502);
  });
});

describe("HTTP server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function start(status: "SUCCESS" | "FAILURE") {
    const { client } = paypalWithVerification(status);
    const server = createApp({ config: FAKE_CONFIG, paypal: client });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves /health and the webhook route", async () => {
    const base = await start("SUCCESS");
    const health = await fetch(`${base}/health`);
    expect(await health.json()).toEqual({ ok: true, paypalEnv: "sandbox" });

    const ok = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: HEADERS, body: JSON.stringify(EVENT) });
    expect(ok.status).toBe(200);

    const missing = await fetch(`${base}/nope`);
    expect(missing.status).toBe(404);
  });

  it("returns 400 from the webhook route when verification fails", async () => {
    const base = await start("FAILURE");
    const res = await fetch(`${base}/webhooks/paypal`, { method: "POST", headers: HEADERS, body: JSON.stringify(EVENT) });
    expect(res.status).toBe(400);
  });
});
