import { TtlMap } from "../util/ttl-map.js";
import type { PayPalApi } from "./offline.js";
import type { PayPalClient } from "./client.js";
import type { CaptureDetail, Dispute, DisputeList, Invoice, InvoiceList, ListDisputesParams, ListInvoicesParams, OrderResponse } from "./types.js";

/**
 * Short cache for PayPal list reads (invoices, disputes), for disputes read by id while the
 * list does not return them yet (pass 3a), and for the reads that complete rebuilt journeys
 * (pass 6), shared by all visitors (F2).
 * Concurrent identical reads share one PayPal call. Raw PayPal data is cached; routes turn it
 * into public DTOs on the way out. Cleared after every executed action and webhook event.
 */
export class PayPalReadCache {
  private readonly entries: TtlMap<string, Promise<unknown>>;

  constructor(
    private readonly ttlMs: number,
    now?: () => number,
  ) {
    this.entries = new TtlMap({ ttlMs: Math.max(1, ttlMs), max: 200, ...(now ? { now } : {}) });
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const hit = this.entries.get(key) as Promise<T> | undefined;
    if (hit) return hit;
    const p = load();
    this.entries.set(key, p);
    p.catch(() => {
      if (this.entries.get(key) === p) this.entries.delete(key);
    });
    return p;
  }

  listInvoices(paypal: PayPalApi, params: ListInvoicesParams): Promise<InvoiceList> {
    return this.cached(`invoices:${JSON.stringify(params)}`, () => paypal.listInvoices(params));
  }

  listDisputes(paypal: PayPalApi, params: ListDisputesParams): Promise<DisputeList> {
    return this.cached(`disputes:${JSON.stringify(params)}`, () => paypal.listDisputes(params));
  }

  getDispute(paypal: PayPalApi, disputeId: string): Promise<Dispute> {
    return this.cached(`dispute:${disputeId}`, () => paypal.getDispute(disputeId));
  }

  /** Pass 6: reads that complete journeys rebuilt after a restart (see src/journeys/rebuild.ts). */
  getInvoice(paypal: PayPalApi, invoiceId: string): Promise<Invoice> {
    return this.cached(`invoice:${invoiceId}`, () => paypal.getInvoice(invoiceId));
  }

  getOrder(paypal: PayPalApi, orderId: string): Promise<OrderResponse> {
    return this.cached(`order:${orderId}`, () => paypal.getOrder(orderId));
  }

  /** Undefined when the PayPal stand-in cannot read captures (offline demo, some tests). */
  getCapture(paypal: PayPalApi, captureId: string): Promise<CaptureDetail> | undefined {
    const reader = paypal as PayPalApi & Partial<Pick<PayPalClient, "getCapture">>;
    if (typeof reader.getCapture !== "function") return undefined;
    return this.cached(`capture:${captureId}`, () => reader.getCapture!(captureId));
  }

  invalidate(): void {
    this.entries.clear();
  }
}
