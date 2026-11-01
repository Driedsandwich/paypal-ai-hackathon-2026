import { TtlMap } from "../util/ttl-map.js";
import type { PayPalApi } from "./offline.js";
import type { DisputeList, InvoiceList, ListDisputesParams, ListInvoicesParams } from "./types.js";

/**
 * Short cache for PayPal list reads (invoices, disputes), shared by all visitors (F2).
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

  invalidate(): void {
    this.entries.clear();
  }
}
