import { baseUrlFor, type PayPalConfig } from "./config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PayPalClientOptions {
  config: PayPalConfig;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Injected for tests. Returns the current time in milliseconds. */
  now?: () => number;
  /** Refresh the token this many seconds before it expires. Default: 60. */
  tokenSafetyMarginSeconds?: number;
}

export class PayPalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

/** Subset of the Orders v2 create request. Extend as the project needs. */
export interface CreateOrderRequest {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<{
    reference_id?: string;
    description?: string;
    amount: { currency_code: string; value: string };
  }>;
  [key: string]: unknown;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface OrderResponse {
  id: string;
  status: string;
  links?: PayPalLink[];
  [key: string]: unknown;
}

/** Body of POST /v1/notifications/verify-webhook-signature. */
export interface VerifyWebhookSignatureRequest {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
  webhook_id: string;
  webhook_event: unknown;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Thin PayPal REST client built on fetch (no SDK).
 * Base URL is chosen from config.env (sandbox or live).
 */
export class PayPalClient {
  readonly baseUrl: string;
  private readonly config: PayPalConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly marginMs: number;
  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(options: PayPalClientOptions) {
    this.config = options.config;
    this.baseUrl = baseUrlFor(options.config.env);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.marginMs = (options.tokenSafetyMarginSeconds ?? 60) * 1000;
  }

  /** OAuth 2.0 client credentials. Reuses the token until shortly before it expires. */
  async getAccessToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs) {
      return this.cached.accessToken;
    }
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const body = await readJson(res);
    if (!res.ok) {
      throw new PayPalApiError(`PayPal token request failed (${res.status})`, res.status, body);
    }
    const { access_token, expires_in } = body as { access_token?: string; expires_in?: number };
    if (typeof access_token !== "string" || typeof expires_in !== "number") {
      throw new PayPalApiError("PayPal token response is missing access_token or expires_in", res.status, body);
    }
    this.cached = {
      accessToken: access_token,
      expiresAtMs: this.now() + expires_in * 1000 - this.marginMs,
    };
    return access_token;
  }

  /** POST /v2/checkout/orders */
  async createOrder(order: CreateOrderRequest, opts: { requestId?: string } = {}): Promise<OrderResponse> {
    return this.request<OrderResponse>("POST", "/v2/checkout/orders", order, opts.requestId);
  }

  /** POST /v2/checkout/orders/{id}/capture */
  async captureOrder(orderId: string, opts: { requestId?: string } = {}): Promise<OrderResponse> {
    if (!orderId) throw new Error("orderId is required");
    return this.request<OrderResponse>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      undefined,
      opts.requestId,
    );
  }

  /**
   * POST /v1/notifications/verify-webhook-signature.
   * Returns true only when PayPal answers verification_status === "SUCCESS".
   */
  async verifyWebhookSignature(req: VerifyWebhookSignatureRequest): Promise<boolean> {
    const body = await this.request<{ verification_status?: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      req,
    );
    return body.verification_status === "SUCCESS";
  }

  private async request<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await readJson(res);
    if (!res.ok) {
      throw new PayPalApiError(`PayPal ${method} ${path} failed (${res.status})`, res.status, parsed);
    }
    return parsed as T;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
