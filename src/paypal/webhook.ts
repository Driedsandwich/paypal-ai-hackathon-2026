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
  /** Called only for events whose signature PayPal confirmed. */
  onEvent?: (event: PayPalWebhookEvent) => Promise<void> | void;
  /**
   * True when this event id was already handled. Such a redelivery is answered 200 without
   * another verification call (nothing is processed again). Ids are only remembered after a
   * successful verification, so a forged event cannot block the real one.
   */
  isDuplicate?: (eventId: string) => boolean;
}

const EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

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
  if (!event || typeof event !== "object" || typeof event.event_type !== "string" || !event.event_type) {
    return { status: 400, body: { ok: false, error: "not a webhook event" } };
  }
  if (typeof event.id !== "string" || !EVENT_ID.test(event.id)) {
    return { status: 400, body: { ok: false, error: "event id missing or invalid" } };
  }
  if (deps.isDuplicate?.(event.id)) {
    return { status: 200, body: { ok: true } };
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

  await deps.onEvent?.(event);
  return { status: 200, body: { ok: true } };
}
