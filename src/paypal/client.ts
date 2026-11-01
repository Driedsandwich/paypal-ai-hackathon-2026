import { randomUUID } from "node:crypto";
import { baseUrlFor, type PayPalConfig } from "./config.js";
import type {
  CreatedInvoice,
  CreateOrderRequest,
  Dispute,
  DisputeEvidence,
  DisputeList,
  EvidenceFile,
  Invoice,
  InvoiceDraft,
  InvoiceList,
  InvoiceSendFlags,
  ListDisputesParams,
  ListInvoicesParams,
  OrderResponse,
  OrderTrackerRequest,
  PayPalLink,
  ShippingTracker,
  SubsequentAction,
  TrackersBatchResponse,
} from "./types.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PayPalClientOptions {
  config: PayPalConfig;
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** Injected for tests. Returns the current time in milliseconds. */
  now?: () => number;
  /** Refresh the token this many seconds before it expires. Default: 60. */
  tokenSafetyMarginSeconds?: number;
  /** Injected for tests. Generates PayPal-Request-Id values. Default: crypto.randomUUID. */
  newRequestId?: () => string;
  /** Abort each PayPal call (request and response body) after this many ms. Default: 15000. */
  timeoutMs?: number;
}

export const PAYPAL_TIMEOUT_MS = 15_000;

/** POSTs that do not change anything a buyer or the seller would see. */
const TECHNICAL_POSTS = new Set(["/v1/oauth2/token", "/v1/notifications/verify-webhook-signature", "/v2/invoicing/generate-next-invoice-number"]);

/**
 * PayPal did not answer in time. For a write (`write: true`) the outcome is unknown: PayPal
 * may or may not have done it, so it must be checked rather than retried.
 */
export class PayPalTimeoutError extends Error {
  readonly write: boolean;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`PayPal ${method} ${path} did not answer within ${Math.round(timeoutMs / 1000)} seconds`);
    this.name = "PayPalTimeoutError";
    this.write = method !== "GET" && !TECHNICAL_POSTS.has(path);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * A failed PayPal call. `debugId` is PayPal's correlation id (from the `debug_id`
 * body field or the `paypal-debug-id` response header); it is safe to show to the
 * seller. Request headers are never stored here.
 */
export class PayPalApiError extends Error {
  readonly debugId: string | undefined;
  readonly errorName: string | undefined;
  readonly details: Array<{ field?: string; issue?: string; description?: string }>;

  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    debugIdHeader?: string,
  ) {
    super(message);
    this.name = "PayPalApiError";
    const b = (body && typeof body === "object" ? body : {}) as {
      debug_id?: unknown;
      name?: unknown;
      error?: unknown;
      details?: unknown;
    };
    this.debugId = typeof b.debug_id === "string" ? b.debug_id : debugIdHeader || undefined;
    this.errorName = typeof b.name === "string" ? b.name : typeof b.error === "string" ? b.error : undefined;
    this.details = Array.isArray(b.details)
      ? (b.details as Array<Record<string, unknown>>).map((d) => ({
          ...(typeof d.field === "string" ? { field: d.field } : {}),
          ...(typeof d.issue === "string" ? { issue: d.issue } : {}),
          ...(typeof d.description === "string" ? { description: d.description } : {}),
        }))
      : [];
  }

  /** PayPal's issue codes from `details[].issue` (e.g. EVIDENCE_TYPE_IS_NOT_ALLOWED). */
  issueCodes(): string[] {
    return this.details.map((d) => d.issue).filter((x): x is string => Boolean(x));
  }

  /** What the seller may see: status, PayPal error name, issues and debug_id. */
  toSafeJSON(): { message: string; status: number; name?: string; debugId?: string; issues?: string[] } {
    const issues = this.details.map((d) => [d.issue, d.description].filter(Boolean).join(": ")).filter(Boolean);
    return {
      message: this.message,
      status: this.status,
      ...(this.errorName ? { name: this.errorName } : {}),
      ...(this.debugId ? { debugId: this.debugId } : {}),
      ...(issues.length ? { issues } : {}),
    };
  }
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

type Query = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Multipart body (Content-Type with boundary is set by fetch). */
  form?: FormData;
  requestId?: string;
}

/**
 * Thin PayPal REST client built on fetch (no SDK).
 * Base URL is chosen from config.env (sandbox or live).
 * Every create/send style call carries a fresh PayPal-Request-Id unless one is given.
 */
export class PayPalClient {
  readonly baseUrl: string;
  private readonly config: PayPalConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly marginMs: number;
  private readonly newRequestId: () => string;
  private readonly timeoutMs: number;
  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(options: PayPalClientOptions) {
    this.config = options.config;
    this.baseUrl = baseUrlFor(options.config.env);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? Date.now;
    this.marginMs = (options.tokenSafetyMarginSeconds ?? 60) * 1000;
    this.newRequestId = options.newRequestId ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? PAYPAL_TIMEOUT_MS;
  }

  /** fetch + body read under one deadline; a timeout becomes PayPalTimeoutError. */
  private async send(method: string, path: string, url: string, init: RequestInit): Promise<{ res: Response; body: unknown }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { ...init, signal });
      return { res, body: await readJson(res) };
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw new PayPalTimeoutError(method, path, this.timeoutMs);
      throw err;
    }
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
    const { res, body } = await this.send("POST", "/v1/oauth2/token", `${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      throw new PayPalApiError(
        `PayPal token request failed (${res.status})`,
        res.status,
        body,
        res.headers.get("paypal-debug-id") ?? undefined,
      );
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

  // ---------------- Orders v2 ----------------

  /** POST /v2/checkout/orders */
  async createOrder(order: CreateOrderRequest, opts: { requestId?: string } = {}): Promise<OrderResponse> {
    return this.request<OrderResponse>("POST", "/v2/checkout/orders", {
      body: order,
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  /** GET /v2/checkout/orders/{id} */
  async getOrder(orderId: string): Promise<OrderResponse> {
    return this.request<OrderResponse>("GET", `/v2/checkout/orders/${seg(orderId, "orderId")}`);
  }

  /** POST /v2/checkout/orders/{id}/capture */
  async captureOrder(orderId: string, opts: { requestId?: string } = {}): Promise<OrderResponse> {
    return this.request<OrderResponse>("POST", `/v2/checkout/orders/${seg(orderId, "orderId")}/capture`, {
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  /** POST /v2/checkout/orders/{id}/track: tracking for an Orders v2 capture. */
  async addOrderTracking(
    orderId: string,
    tracker: OrderTrackerRequest,
    opts: { requestId?: string } = {},
  ): Promise<OrderResponse> {
    return this.request<OrderResponse>("POST", `/v2/checkout/orders/${seg(orderId, "orderId")}/track`, {
      body: tracker,
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  // ---------------- Invoicing v2 ----------------

  /** POST /v2/invoicing/generate-next-invoice-number */
  async generateNextInvoiceNumber(opts: { requestId?: string } = {}): Promise<string> {
    const body = await this.request<{ invoice_number?: string }>("POST", "/v2/invoicing/generate-next-invoice-number", {
      requestId: opts.requestId ?? this.newRequestId(),
    });
    if (!body?.invoice_number) throw new Error("PayPal did not return an invoice_number");
    return body.invoice_number;
  }

  /**
   * POST /v2/invoicing/invoices: creates a DRAFT invoice.
   * PayPal answers 201 with the invoice or with a `self` link; both are handled.
   */
  async createDraftInvoice(invoice: InvoiceDraft, opts: { requestId?: string } = {}): Promise<CreatedInvoice> {
    const body = await this.request<(Partial<Invoice> & Partial<PayPalLink>) | undefined>(
      "POST",
      "/v2/invoicing/invoices",
      { body: invoice, requestId: opts.requestId ?? this.newRequestId() },
    );
    if (body && typeof body.id === "string" && body.id) {
      return { id: body.id, invoice: body as Invoice };
    }
    const href = body?.href;
    const id = typeof href === "string" ? href.split("?")[0]!.split("/").filter(Boolean).pop() : undefined;
    if (!id) throw new Error("PayPal create-invoice response has neither id nor href");
    return { id, href: href! };
  }

  /**
   * POST /v2/invoicing/invoices/{id}/send. Returns PayPal's link (the payer view) when present.
   * Only the send flags are sent: PayPal does not honor a custom subject or note here.
   */
  async sendInvoice(invoiceId: string, flags: InvoiceSendFlags = {}, opts: { requestId?: string } = {}): Promise<PayPalLink | undefined> {
    const body = await this.request<PayPalLink | undefined>(
      "POST",
      `/v2/invoicing/invoices/${seg(invoiceId, "invoiceId")}/send`,
      { body: sendFlags(flags), requestId: opts.requestId ?? this.newRequestId() },
    );
    return body && typeof body.href === "string" ? body : undefined;
  }

  /**
   * POST /v2/invoicing/invoices/{id}/remind (204, no body): PayPal's standard reminder.
   * Only the send flags are sent: PayPal does not honor a custom subject or note here.
   */
  async remindInvoice(invoiceId: string, flags: InvoiceSendFlags = {}, opts: { requestId?: string } = {}): Promise<void> {
    await this.request<undefined>("POST", `/v2/invoicing/invoices/${seg(invoiceId, "invoiceId")}/remind`, {
      body: sendFlags(flags),
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  /** GET /v2/invoicing/invoices/{id} */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    return this.request<Invoice>("GET", `/v2/invoicing/invoices/${seg(invoiceId, "invoiceId")}`);
  }

  /** GET /v2/invoicing/invoices?page=&page_size=&total_required=&fields= */
  async listInvoices(params: ListInvoicesParams = {}): Promise<InvoiceList> {
    return this.request<InvoiceList>("GET", "/v2/invoicing/invoices", { query: { ...params } });
  }

  // ---------------- Add Tracking v1 ----------------

  /**
   * POST /v1/shipping/trackers-batch: tracking for PayPal transactions that are
   * not Orders v2 captures (e.g. invoice payments). PayPal answers 200 even when
   * some trackers fail; those come back in `errors` and are raised here.
   */
  async addTrackersBatch(trackers: ShippingTracker[], opts: { requestId?: string } = {}): Promise<TrackersBatchResponse> {
    if (trackers.length === 0 || trackers.length > 20) throw new Error("trackers-batch accepts 1 to 20 trackers");
    const body = await this.request<TrackersBatchResponse>("POST", "/v1/shipping/trackers-batch", {
      body: { trackers },
      requestId: opts.requestId ?? this.newRequestId(),
    });
    const errors = body?.errors ?? [];
    if (errors.length > 0) {
      const first = errors[0]!;
      throw new PayPalApiError(`PayPal could not add tracking (${first.name ?? "error"})`, 200, first);
    }
    return body ?? {};
  }

  // ---------------- Customer Disputes v1 ----------------

  /** GET /v1/customer/disputes */
  async listDisputes(params: ListDisputesParams = {}): Promise<DisputeList> {
    return this.request<DisputeList>("GET", "/v1/customer/disputes", { query: { ...params } });
  }

  /** GET /v1/customer/disputes/{id} */
  async getDispute(disputeId: string): Promise<Dispute> {
    return this.request<Dispute>("GET", `/v1/customer/disputes/${seg(disputeId, "disputeId")}`);
  }

  /**
   * POST /v1/customer/disputes/{id}/provide-evidence (multipart/form-data).
   * Part `input` carries the JSON `{ evidences: [...] }`; files go in `evidence-file` parts.
   */
  async provideDisputeEvidence(
    disputeId: string,
    evidences: DisputeEvidence[],
    files: EvidenceFile[] = [],
    opts: { requestId?: string } = {},
  ): Promise<SubsequentAction> {
    if (evidences.length === 0) throw new Error("at least one evidence item is required");
    const form = new FormData();
    form.append("input", new Blob([JSON.stringify({ evidences })], { type: "application/json" }));
    for (const f of files) {
      form.append("evidence-file", new Blob([f.data as BlobPart], { type: f.contentType }), f.name);
    }
    return this.request<SubsequentAction>(
      "POST",
      `/v1/customer/disputes/${seg(disputeId, "disputeId")}/provide-evidence`,
      { form, requestId: opts.requestId ?? this.newRequestId() },
    );
  }

  /** POST /v1/customer/disputes/{id}/send-message with `{ message }` (1-2000 chars). */
  async sendDisputeMessage(disputeId: string, message: string, opts: { requestId?: string } = {}): Promise<SubsequentAction> {
    if (!message || message.length > 2000) throw new Error("message must be 1 to 2000 characters");
    return this.request<SubsequentAction>("POST", `/v1/customer/disputes/${seg(disputeId, "disputeId")}/send-message`, {
      body: { message },
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  /** POST /v1/customer/disputes/{id}/accept-claim with `{ note }`. Refunds the buyer. */
  async acceptDisputeClaim(disputeId: string, note: string, opts: { requestId?: string } = {}): Promise<SubsequentAction> {
    if (!note || note.length > 2000) throw new Error("note must be 1 to 2000 characters");
    return this.request<SubsequentAction>("POST", `/v1/customer/disputes/${seg(disputeId, "disputeId")}/accept-claim`, {
      body: { note },
      requestId: opts.requestId ?? this.newRequestId(),
    });
  }

  // ---------------- Webhooks ----------------

  /**
   * POST /v1/notifications/verify-webhook-signature.
   * Returns true only when PayPal answers verification_status === "SUCCESS".
   */
  async verifyWebhookSignature(req: VerifyWebhookSignatureRequest): Promise<boolean> {
    const body = await this.request<{ verification_status?: string }>(
      "POST",
      "/v1/notifications/verify-webhook-signature",
      { body: req },
    );
    return body?.verification_status === "SUCCESS";
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (!opts.form) headers["Content-Type"] = "application/json";
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    const { res, body: parsed } = await this.send(method, path, `${this.baseUrl}${path}${queryString(opts.query)}`, {
      method,
      headers,
      ...(opts.form ? { body: opts.form } : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    if (!res.ok) {
      throw new PayPalApiError(
        `PayPal ${method} ${path} failed (${res.status})`,
        res.status,
        parsed,
        res.headers.get("paypal-debug-id") ?? undefined,
      );
    }
    return parsed as T;
  }
}

/** Copies only the supported flags (drops subject/note/recipients PayPal would ignore). */
function sendFlags(flags: InvoiceSendFlags): InvoiceSendFlags {
  return {
    ...(flags.send_to_recipient !== undefined ? { send_to_recipient: flags.send_to_recipient } : {}),
    ...(flags.send_to_invoicer !== undefined ? { send_to_invoicer: flags.send_to_invoicer } : {}),
  };
}

function seg(value: string, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return encodeURIComponent(value);
}

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : "";
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
