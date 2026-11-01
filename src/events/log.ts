import type { PayPalWebhookEvent } from "../paypal/webhook.js";

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

/**
 * In-memory, bounded log of verified webhook events (no database by design).
 * Duplicate deliveries (same event id) are stored once.
 */
export class EventLog {
  private readonly events: LoggedEvent[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly max = 200,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(event: PayPalWebhookEvent): LoggedEvent | undefined {
    if (this.seen.has(event.id)) return undefined;
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
    this.seen.add(event.id);
    while (this.events.length > this.max) {
      const dropped = this.events.pop()!;
      this.seen.delete(dropped.id);
    }
    return logged;
  }

  /** Newest first. */
  list(filter?: { category?: EventCategory }): LoggedEvent[] {
    return this.events.filter((e) => !filter?.category || e.category === filter.category);
  }
}
