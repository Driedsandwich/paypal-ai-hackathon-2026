import type { VerifyWebhookSignatureRequest } from "./client.js";

/** Minimal shape of a PayPal webhook event. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  resource?: unknown;
  [key: string]: unknown;
}

export interface WebhookRequest {
  /** Header names are expected in lower case (as node:http gives them). */
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  body: { ok: boolean; error?: string };
}

export interface WebhookHandlerDeps {
  webhookId: string | undefined;
  verify: (req: VerifyWebhookSignatureRequest) => Promise<boolean>;
  /** Called only for events whose signature PayPal confirmed. Empty for now. */
  onEvent?: (event: PayPalWebhookEvent) => Promise<void> | void;
}

const HEADER_MAP = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

function header(headers: WebhookRequest["headers"], name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Framework-free webhook handler: parse, verify via PayPal's
 * verify-webhook-signature API, then hand the event to onEvent.
 */
export async function handlePayPalWebhook(req: WebhookRequest, deps: WebhookHandlerDeps): Promise<WebhookResponse> {
  if (!deps.webhookId) {
    return { status: 500, body: { ok: false, error: "PAYPAL_WEBHOOK_ID is not configured" } };
  }

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(req.rawBody) as PayPalWebhookEvent;
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON" } };
  }
  if (!event || typeof event !== "object" || typeof event.event_type !== "string") {
    return { status: 400, body: { ok: false, error: "not a webhook event" } };
  }

  const fields: Partial<Record<keyof typeof HEADER_MAP, string>> = {};
  for (const [key, name] of Object.entries(HEADER_MAP) as Array<[keyof typeof HEADER_MAP, string]>) {
    const value = header(req.headers, name);
    if (!value) return { status: 400, body: { ok: false, error: `missing header ${name}` } };
    fields[key] = value;
  }

  let verified: boolean;
  try {
    verified = await deps.verify({
      ...(fields as Record<keyof typeof HEADER_MAP, string>),
      webhook_id: deps.webhookId,
      webhook_event: event,
    });
  } catch {
    return { status: 502, body: { ok: false, error: "signature verification request failed" } };
  }
  if (!verified) {
    return { status: 400, body: { ok: false, error: "signature verification failed" } };
  }

  // TODO: route events (e.g. CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED) once the project is chosen.
  await deps.onEvent?.(event);
  return { status: 200, body: { ok: true } };
}
