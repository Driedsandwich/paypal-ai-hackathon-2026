import type { PayPalWebhookEvent } from "../paypal/webhook.js";
import { TtlMap } from "../util/ttl-map.js";

/** Webhook event types this app acts on (spec 3.1). Others are logged as "ignored". */
export const ROUTED_EVENT_TYPES = [
  "INVOICING.INVOICE.PAID",
  "PAYMENT.CAPTURE.COMPLETED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
] as const;

export type RoutedEventType = (typeof ROUTED_EVENT_TYPES)[number];

export type EventCategory = "invoice" | "payment" | "dispute" | "ignored";

export interface LoggedEvent {
  /** PayPal webhook event id. */
  id: string;
  eventType: string;
  category: EventCategory;
  receivedAt: string;
  summary: string;
  /** Id of the PayPal resource the event is about (invoice, capture or dispute id). */
  resourceId?: string;
}

function categoryOf(type: string): EventCategory {
  switch (type) {
    case "INVOICING.INVOICE.PAID":
      return "invoice";
    case "PAYMENT.CAPTURE.COMPLETED":
      return "payment";
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED":
      return "dispute";
    default:
      return "ignored";
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** Pulls a short, non-personal summary out of the event resource. */
function summarize(event: PayPalWebhookEvent): { summary: string; resourceId?: string } {
  const r = (event.resource ?? {}) as Record<string, unknown>;
  switch (event.event_type) {
    case "INVOICING.INVOICE.PAID": {
      const inv = (r.invoice ?? r) as Record<string, unknown>;
      const detail = (inv.detail ?? {}) as Record<string, unknown>;
      const id = str(inv.id);
      return { summary: `Invoice ${str(detail.invoice_number) ?? id ?? "?"} was paid`, ...(id ? { resourceId: id } : {}) };
    }
    case "PAYMENT.CAPTURE.COMPLETED": {
      const amount = (r.amount ?? {}) as Record<string, unknown>;
      const id = str(r.id);
      const money = str(amount.value) ? ` (${str(amount.value)} ${str(amount.currency_code) ?? ""})`.trimEnd() : "";
      return { summary: `Payment ${id ?? "?"} completed${money}`, ...(id ? { resourceId: id } : {}) };
    }
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED": {
      const id = str(r.dispute_id);
      const verb = event.event_type.endsWith("CREATED") ? "opened" : "updated";
      return {
        summary: `Dispute ${id ?? "?"} ${verb}${str(r.reason) ? ` (${str(r.reason)})` : ""}${str(r.status) ? `, status ${str(r.status)}` : ""}`,
        ...(id ? { resourceId: id } : {}),
      };
    }
    default:
      return { summary: `Event ${event.event_type} received (not used by this app)` };
  }
}

/** PayPal retries a webhook delivery for up to 3 days, so ids are remembered that long. */
export const WEBHOOK_DEDUP_TTL_MS = 3 * 86_400_000;
export const WEBHOOK_DEDUP_MAX = 20_000;

/**
 * Remembers webhook event ids for 3 days (bounded), independently of the display log, so a
 * redelivery is recognized even after the event has scrolled out of the 200-entry log.
 * In memory: a restart forgets the ids.
 */
export class WebhookDedup {
  private readonly ids: TtlMap<string, true>;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ids = new TtlMap({ ttlMs: options.ttlMs ?? WEBHOOK_DEDUP_TTL_MS, max: options.max ?? WEBHOOK_DEDUP_MAX, ...(options.now ? { now: options.now } : {}) });
  }

  seen(id: string): boolean {
    return this.ids.has(id);
  }

  remember(id: string): void {
    this.ids.set(id, true);
  }
}

/**
 * In-memory, bounded log of verified webhook events (no database by design).
 * Duplicate deliveries (same event id, within 3 days) are stored once.
 */
export class EventLog {
  private readonly events: LoggedEvent[] = [];

  constructor(
    private readonly max = 200,
    private readonly now: () => Date = () => new Date(),
    readonly dedup: WebhookDedup = new WebhookDedup({ now: () => now().getTime() }),
  ) {}

  /** True when this event id was recorded within the dedup window. */
  hasSeen(id: string): boolean {
    return this.dedup.seen(id);
  }

  record(event: PayPalWebhookEvent): LoggedEvent | undefined {
    if (typeof event.id !== "string" || !event.id) return undefined;
    if (this.dedup.seen(event.id)) return undefined;
    const { summary, resourceId } = summarize(event);
    const logged: LoggedEvent = {
      id: event.id,
      eventType: event.event_type,
      category: categoryOf(event.event_type),
      receivedAt: this.now().toISOString(),
      summary,
      ...(resourceId ? { resourceId } : {}),
    };
    this.events.unshift(logged);
    this.dedup.remember(event.id);
    if (this.events.length > this.max) this.events.length = this.max;
    return logged;
  }

  /** Newest first. */
  list(filter?: { category?: EventCategory }): LoggedEvent[] {
    return this.events.filter((e) => !filter?.category || e.category === filter.category);
  }
}
