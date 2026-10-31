import { describe, expect, it } from "vitest";
import { PayPalApiError, PayPalClient } from "../src/paypal/client.js";
import { baseUrlFor, loadPayPalConfigFromEnv, parsePayPalEnv } from "../src/paypal/config.js";
import { createFakeFetch, FAKE_CONFIG } from "./helpers/fake-fetch.js";

const SANDBOX = "https://api-m.sandbox.paypal.com";

function tokenRoute(expiresIn = 32400, token = "fake-access-token-1") {
  return { status: 200, json: { access_token: token, token_type: "Bearer", expires_in: expiresIn } };
}

describe("config", () => {
  it("defaults to sandbox and switches base URL by env", () => {
    expect(parsePayPalEnv(undefined)).toBe("sandbox");
    expect(parsePayPalEnv("")).toBe("sandbox");
    expect(parsePayPalEnv("LIVE")).toBe("live");
    expect(() => parsePayPalEnv("prod")).toThrow();
    expect(baseUrlFor("sandbox")).toBe(SANDBOX);
    expect(baseUrlFor("live")).toBe("https://api-m.paypal.com");
  });

  it("loads from env and requires credentials", () => {
    expect(() => loadPayPalConfigFromEnv({})).toThrow(/PAYPAL_CLIENT_ID/);
    const cfg = loadPayPalConfigFromEnv({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_ENV: "live" });
    expect(cfg.env).toBe("live");
    expect(cfg.webhookId).toBeUndefined();
  });

  it("live config hits the live host", async () => {
    const { fetch, calls } = createFakeFetch(() => tokenRoute());
    const client = new PayPalClient({ config: { ...FAKE_CONFIG, env: "live" }, fetch });
    await client.getAccessToken();
    expect(calls[0]!.url).toBe("https://api-m.paypal.com/v1/oauth2/token");
  });
});

describe("OAuth token", () => {
  it("requests a token with client credentials and Basic auth", async () => {
    const { fetch, calls } = createFakeFetch((c) => (c.url.endsWith("/v1/oauth2/token") ? tokenRoute() : undefined));
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });

    await expect(client.getAccessToken()).resolves.toBe("fake-access-token-1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${SANDBOX}/v1/oauth2/token`);
    expect(call.method).toBe("POST");
    expect(call.body).toBe("grant_type=client_credentials");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const expected = Buffer.from("test-client-id:test-client-secret").toString("base64");
    expect(call.headers.Authorization).toBe(`Basic ${expected}`);
  });

  it("reuses the token until it nears expiry, then refreshes", async () => {
    let now = 1_000_000;
    let n = 0;
    const { fetch, calls } = createFakeFetch(() => {
      n += 1;
      return tokenRoute(3600, `fake-access-token-${n}`);
    });
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch, now: () => now, tokenSafetyMarginSeconds: 60 });

    expect(await client.getAccessToken()).toBe("fake-access-token-1");
    now += 3000 * 1000;
    expect(await client.getAccessToken()).toBe("fake-access-token-1");
    expect(calls).toHaveLength(1);

    now += 600 * 1000; // past (3600 - 60) seconds
    expect(await client.getAccessToken()).toBe("fake-access-token-2");
    expect(calls).toHaveLength(2);
  });

  it("shares one request between concurrent callers", async () => {
    const { fetch, calls } = createFakeFetch(() => tokenRoute());
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });
    const [a, b] = await Promise.all([client.getAccessToken(), client.getAccessToken()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("throws PayPalApiError on a failed token request", async () => {
    const { fetch } = createFakeFetch(() => ({ status: 401, json: { error: "invalid_client" } }));
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });
    const err = await client.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).status).toBe(401);
  });
});

describe("Orders v2", () => {
  it("creates an order with Bearer auth and the given body", async () => {
    const { fetch, calls } = createFakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return tokenRoute();
      if (c.url === `${SANDBOX}/v2/checkout/orders`) {
        return {
          status: 201,
          json: {
            id: "5O190127TN364715T",
            status: "CREATED",
            links: [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T", rel: "approve", method: "GET" }],
          },
        };
      }
      return undefined;
    });
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });

    const order = await client.createOrder(
      { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] },
      { requestId: "req-1" },
    );

    expect(order.id).toBe("5O190127TN364715T");
    expect(order.status).toBe("CREATED");
    expect(order.links?.find((l) => l.rel === "approve")).toBeDefined();
    const call = calls[1]!;
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer fake-access-token-1");
    expect(call.headers["PayPal-Request-Id"]).toBe("req-1");
    expect(JSON.parse(call.body!)).toEqual({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }],
    });
  });

  it("captures an order", async () => {
    const { fetch, calls } = createFakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return tokenRoute();
      if (c.url === `${SANDBOX}/v2/checkout/orders/ORDER-123/capture`) {
        return {
          status: 201,
          json: {
            id: "ORDER-123",
            status: "COMPLETED",
            purchase_units: [{ payments: { captures: [{ id: "CAPTURE-1", status: "COMPLETED" }] } }],
          },
        };
      }
      return undefined;
    });
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });

    const result = await client.captureOrder("ORDER-123");

    expect(result.status).toBe("COMPLETED");
    expect(calls.map((c) => c.url)).toEqual([
      `${SANDBOX}/v1/oauth2/token`,
      `${SANDBOX}/v2/checkout/orders/ORDER-123/capture`,
    ]);
    expect(calls[1]!.body).toBeUndefined();
  });

  it("surfaces PayPal errors with status and body", async () => {
    const { fetch } = createFakeFetch((c) => {
      if (c.url.endsWith("/v1/oauth2/token")) return tokenRoute();
      return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] } };
    });
    const client = new PayPalClient({ config: FAKE_CONFIG, fetch });
    const err = await client.captureOrder("ORDER-123").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).status).toBe(422);
    expect((err as PayPalApiError).body).toMatchObject({ name: "UNPROCESSABLE_ENTITY" });
  });
});
