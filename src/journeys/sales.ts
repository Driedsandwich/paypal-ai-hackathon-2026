import { TtlMap } from "../util/ttl-map.js";
import type { Money } from "../paypal/types.js";
import type { ListingForSale } from "../agent/schemas.js";

/** Buyer countries offered in the UI (ISO 3166-1 alpha-2 → English name). */
export const COUNTRIES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  AU: "Australia",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  IT: "Italy",
  ES: "Spain",
  SG: "Singapore",
  HK: "Hong Kong",
  TW: "Taiwan",
  KR: "South Korea",
};

export function isCountry(code: string): boolean {
  return Object.hasOwn(COUNTRIES, code);
}

/**
 * Marker written into what this app creates at PayPal: `detail.reference` of an invoice and
 * `purchase_units[0].custom_id` of an order. It lets the app recognise its own invoices and
 * orders from a PayPal read, also after a restart wiped the in-memory registry.
 * Example: "Okuri OK-1042 US".
 */
const MARKER = /^Okuri (OK-\d{4,6}) ([A-Z]{2})$/;

export function saleMarker(saleId: string, country: string): string {
  return `Okuri ${saleId} ${country}`;
}

export function parseSaleMarker(value: unknown): { saleId: string; country: string } | undefined {
  if (typeof value !== "string") return undefined;
  const m = MARKER.exec(value.trim());
  return m ? { saleId: m[1]!, country: m[2]! } : undefined;
}

export interface SaleActivity {
  at: string;
  text: string;
}

/** One sale followed from the seller in Japan to the buyer abroad (a "journey"). */
export interface Sale {
  /** Display number, e.g. "OK-1042". */
  id: string;
  /** Session that started the sale; "" for sales rebuilt from PayPal data (no owner known). */
  owner: string;
  createdAt: string;
  titleJa?: string;
  titleEn: string;
  /** What is needed to bill the buyer (kept until an invoice exists). */
  listing?: ListingForSale;
  buyerAlias: string;
  /** Buyer country, ISO 3166-1 alpha-2. */
  country: string;
  amount?: Money;
  path: "invoice" | "order";
  invoiceId?: string;
  invoiceNumber?: string;
  orderId?: string;
  captureId?: string;
  /** PayPal transaction id of the payment (invoice payments). */
  transactionId?: string;
  paidAt?: string;
  tracking?: { carrier: string; number: string; at: string };
  /** Offline simulator only: the parcel was delivered. */
  deliveredAt?: string;
  /** Which AI provider and model drafted the listing. */
  draftedBy?: { provider: string; model?: string };
  activity: SaleActivity[];
}

export const SALE_REGISTRY_TTL_MS = 7 * 86_400_000;
export const SALE_REGISTRY_MAX = 5_000;
const MAX_ACTIVITY = 30;

/**
 * Sales started on this server (in memory, bounded, 7-day expiry), indexed by the invoice or
 * order created for them. Also the allowlist for tracking proposals: tracking can be proposed
 * only for invoices and orders this demo created (registry hit, or the marker above in the
 * PayPal record).
 */
export class SaleRegistry {
  private readonly sales: TtlMap<string, Sale>;
  private readonly byInvoiceId = new Map<string, string>();
  private readonly byOrderId = new Map<string, string>();
  private counter: number;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number; firstNumber?: number } = {}) {
    this.sales = new TtlMap({ ttlMs: options.ttlMs ?? SALE_REGISTRY_TTL_MS, max: options.max ?? SALE_REGISTRY_MAX, ...(options.now ? { now: options.now } : {}) });
    // Start somewhere random so numbers from an earlier run (still in PayPal markers) rarely repeat.
    this.counter = options.firstNumber ?? 1000 + Math.floor(Math.random() * 8000);
  }

  private nextId(): string {
    for (;;) {
      this.counter = this.counter >= 999_999 ? 1000 : this.counter + 1;
      const id = `OK-${this.counter}`;
      if (!this.sales.has(id)) return id;
    }
  }

  create(fields: Omit<Sale, "id" | "createdAt" | "activity"> & { createdAt?: string; activity?: SaleActivity[] }): Sale {
    const sale: Sale = { ...fields, id: this.nextId(), createdAt: fields.createdAt ?? new Date().toISOString(), activity: fields.activity ?? [] };
    this.sales.set(sale.id, sale);
    return sale;
  }

  /** Adds a sale rebuilt from a PayPal record (keeps its id from the marker). */
  adopt(sale: Sale): Sale {
    const existing = this.sales.get(sale.id);
    if (existing) return existing;
    this.sales.set(sale.id, sale);
    if (sale.invoiceId) this.byInvoiceId.set(sale.invoiceId, sale.id);
    if (sale.orderId) this.byOrderId.set(sale.orderId, sale.id);
    return sale;
  }

  get(id: string): Sale | undefined {
    return this.sales.get(id);
  }

  byInvoice(invoiceId: string): Sale | undefined {
    const id = this.byInvoiceId.get(invoiceId);
    const sale = id ? this.sales.get(id) : undefined;
    if (!sale) this.byInvoiceId.delete(invoiceId);
    return sale;
  }

  byOrder(orderId: string): Sale | undefined {
    const id = this.byOrderId.get(orderId);
    const sale = id ? this.sales.get(id) : undefined;
    if (!sale) this.byOrderId.delete(orderId);
    return sale;
  }

  byTransaction(transactionId: string): Sale | undefined {
    return this.all().find((s) => s.transactionId === transactionId);
  }

  /**
   * The sale whose payment has this seller transaction id, as a dispute names it in
   * `disputed_transactions[].seller_transaction_id`: the invoice payment's transaction id or
   * the order's capture id. (Tracking keeps using `byTransaction`, invoice payments only.)
   */
  bySellerTransaction(id: string): Sale | undefined {
    return this.all().find((s) => s.transactionId === id || s.captureId === id);
  }

  attachInvoice(saleId: string, invoiceId: string, invoiceNumber?: string): Sale | undefined {
    const sale = this.sales.get(saleId);
    if (!sale) return undefined;
    sale.invoiceId = invoiceId;
    if (invoiceNumber) sale.invoiceNumber = invoiceNumber;
    delete sale.listing;
    this.byInvoiceId.set(invoiceId, saleId);
    return sale;
  }

  attachOrder(saleId: string, orderId: string): Sale | undefined {
    const sale = this.sales.get(saleId);
    if (!sale) return undefined;
    sale.orderId = orderId;
    delete sale.listing;
    this.byOrderId.set(orderId, saleId);
    return sale;
  }

  note(sale: Sale | undefined, text: string, at: string = new Date().toISOString()): void {
    if (!sale) return;
    sale.activity.push({ at, text });
    sale.activity.sort((a, b) => a.at.localeCompare(b.at));
    if (sale.activity.length > MAX_ACTIVITY) sale.activity.splice(0, sale.activity.length - MAX_ACTIVITY);
  }

  all(): Sale[] {
    return this.sales.values();
  }

  /** Removes every sale of one session (the offline simulator starts a fresh world). */
  removeOwner(owner: string): void {
    for (const s of this.all()) {
      if (s.owner !== owner) continue;
      this.sales.delete(s.id);
      if (s.invoiceId) this.byInvoiceId.delete(s.invoiceId);
      if (s.orderId) this.byOrderId.delete(s.orderId);
    }
  }

  /**
   * Sales a visitor may see. A sale that exists only in this app (draft, invoice not yet
   * created) is private to its session. Once PayPal holds the invoice or order it belongs to
   * the shared sandbox account and is visible to every visitor, like the invoice list was in
   * pass 1. In the offline simulator every visitor has a private world, so only their own.
   */
  visibleTo(session: string, privateWorlds: boolean): Sale[] {
    return this.all().filter((s) => s.owner === session || (!privateWorlds && Boolean(s.invoiceId || s.orderId)));
  }
}
