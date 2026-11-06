import { PayPalApiError } from "../paypal/client.js";
import type { PayPalApi } from "../paypal/offline.js";
import type { PayPalReadCache } from "../paypal/read-cache.js";
import type { Dispute } from "../paypal/types.js";
import { TtlMap } from "../util/ttl-map.js";
import type { Sale, SaleRegistry } from "./sales.js";

// Dispute discovery (pass 3a). A real sandbox test showed that a buyer-opened dispute could be
// read by id (GET /v1/customer/disputes/{id}) but did not appear in the list endpoint for at
// least 3 minutes (test/fixtures/sandbox-dispute-20261101.json). So the app keeps a bounded
// registry of dispute ids it knows from three sources: PayPal's list, verified
// CUSTOMER.DISPUTE.* webhooks, and "Open a case by ID" (plus any successful read by id).
// Ids known only from a webhook or by id are read one by one until the list catches up.

export type DisputeSource = "list" | "webhook" | "by_id";

export interface KnownDispute {
  id: string;
  sources: DisputeSource[];
  firstSeen: string;
  /** What PayPal last said about it, reduced (no messages, evidence or buyer details). */
  data?: Dispute;
  /** When a listed case without seller ids was last read by id to link it (ms). */
  fillTriedAt?: number;
}

/** One dispute as the app shows it: PayPal's data plus where the app learned about it. */
export interface DisputeView {
  dispute: Dispute;
  /** True when the data comes from a read by id now (so its action links can be trusted). */
  detailed: boolean;
  /** False while PayPal's list does not return this dispute yet. */
  inList: boolean;
  sources: DisputeSource[];
}

export const DISPUTE_REGISTRY_TTL_MS = 30 * 86_400_000;
export const DISPUTE_REGISTRY_MAX = 2_000;
/** Ids not in PayPal's list are read by id, at most this many per page load (newest first). */
export const MAX_DISPUTE_READS_BY_ID = 10;
/**
 * Listed cases whose list item names no seller transaction (PayPal's sandbox list gives only
 * buyer_transaction_id, checked 2026-11-06) are read by id to link them to a sale: at most this
 * many per page load, each at most once per DISPUTE_FILL_RETRY_MS.
 */
export const MAX_DISPUTE_FILL_READS = 2;
export const DISPUTE_FILL_RETRY_MS = 10 * 60_000;
/**
 * A registered id that PayPal answers 404 for is dropped, but only after this long: a case
 * announced by a verified webhook may not be readable at once (PayPal's list lags too).
 */
export const NOT_FOUND_GRACE_MS = 3_600_000;

/**
 * Case ids as PayPal shows them ("PP-D-27803", "PP-R-EMU-10195761", "PP-000-042-663-135";
 * the offline simulator uses "PP-D-OFF…"). Upper-cased before the check.
 */
const DISPUTE_ID = /^PP-[A-Z0-9]+(?:-[A-Z0-9]+){0,6}$/;

/** The canonical case id, or undefined when the text is not one. */
export function parseDisputeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toUpperCase();
  return id.length <= 64 && DISPUTE_ID.test(id) ? id : undefined;
}

/** Keeps only what the app needs: no messages, no evidence, no buyer objects. */
export function reduceDispute(d: Dispute): Dispute {
  const out: Dispute = { dispute_id: d.dispute_id };
  for (const k of ["create_time", "update_time", "reason", "status", "dispute_state", "dispute_life_cycle_stage", "dispute_channel", "seller_response_due_date"] as const) {
    const v = d[k];
    if (typeof v === "string") (out as Record<string, unknown>)[k] = v;
  }
  if (d.dispute_amount?.value) out.dispute_amount = { currency_code: d.dispute_amount.currency_code, value: d.dispute_amount.value };
  if (Array.isArray(d.disputed_transactions)) {
    out.disputed_transactions = d.disputed_transactions.slice(0, 10).map((t) => ({
      ...(t.seller_transaction_id ? { seller_transaction_id: t.seller_transaction_id } : {}),
      ...(t.invoice_number ? { invoice_number: t.invoice_number } : {}),
      ...(t.transaction_status ? { transaction_status: t.transaction_status } : {}),
      ...(t.gross_amount?.value ? { gross_amount: { currency_code: t.gross_amount.currency_code, value: t.gross_amount.value } } : {}),
    }));
  }
  if (Array.isArray(d.links)) out.links = d.links.slice(0, 20).map((l) => ({ href: l.href, rel: l.rel, ...(l.method ? { method: l.method } : {}) }));
  if (d.allowed_response_options) out.allowed_response_options = d.allowed_response_options;
  return out;
}

/**
 * Bounded, in-memory registry of dispute ids this server knows (30 days, 2,000 entries,
 * oldest dropped first). Shared by all visitors, like the sandbox account's dispute list.
 * Not used in the offline demo (each visitor has a private simulator whose list is complete).
 */
export class DisputeRegistry {
  private readonly entries: TtlMap<string, KnownDispute>;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.entries = new TtlMap({ ttlMs: options.ttlMs ?? DISPUTE_REGISTRY_TTL_MS, max: options.max ?? DISPUTE_REGISTRY_MAX, ...(options.now ? { now: options.now } : {}) });
  }

  /**
   * Records that `source` showed this dispute; `data` (if given) replaces the stored data.
   * Transaction ids are kept when newer data lacks them (list items may omit them), and action
   * links only come from reads by id.
   */
  note(id: string, source: DisputeSource, data?: Dispute, detailed = false): KnownDispute {
    const existing = this.entries.get(id);
    const entry: KnownDispute = existing ?? { id, sources: [], firstSeen: new Date(this.options.now?.() ?? Date.now()).toISOString() };
    if (!entry.sources.includes(source)) entry.sources.push(source);
    if (data) {
      const next = reduceDispute(data);
      const old = entry.data;
      if (!hasSaleIds(next.disputed_transactions) && hasSaleIds(old?.disputed_transactions)) next.disputed_transactions = old?.disputed_transactions;
      if (!detailed) {
        if (old?.links) next.links = old.links;
        else delete next.links;
        if (old?.allowed_response_options) next.allowed_response_options = old.allowed_response_options;
        else delete next.allowed_response_options;
      }
      entry.data = next;
    }
    this.entries.set(id, entry); // refreshes the expiry and moves it to the newest end
    return entry;
  }

  get(id: string): KnownDispute | undefined {
    return this.entries.get(id);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  /** PayPal says 404: forget the id unless it was registered within NOT_FOUND_GRACE_MS. */
  notFound(id: string): void {
    const e = this.entries.get(id);
    if (e && (this.options.now?.() ?? Date.now()) - Date.parse(e.firstSeen) >= NOT_FOUND_GRACE_MS) this.entries.delete(id);
  }

  /** Newest first. */
  all(): KnownDispute[] {
    return this.entries.values().reverse();
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Runs one background read per dispute id at a time (webhook follow-ups; a second event for
   * the same id while the first read runs shares it). Never rejects.
   */
  background(id: string, work: () => Promise<unknown>): Promise<unknown> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = work()
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  /** Resolves when no background read is running (for tests and shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight.values()]);
  }
}

type Tx = { seller_transaction_id?: string; invoice_number?: string };

/** True when some transaction names the seller's payment (seller_transaction_id) or the invoice number. */
function hasSaleIds(t?: Tx[]): boolean {
  return (t ?? []).some((x) => Boolean(x.seller_transaction_id || x.invoice_number));
}

/** True when the dispute is about this sale's payment (invoice transaction or order capture). */
export function disputeMatchesSale(d: { disputed_transactions?: Tx[] }, sale: Sale): boolean {
  return (d.disputed_transactions ?? []).some(
    (t) =>
      (t.seller_transaction_id && (t.seller_transaction_id === sale.transactionId || t.seller_transaction_id === sale.captureId)) ||
      (t.invoice_number && sale.invoiceNumber && t.invoice_number === sale.invoiceNumber),
  );
}

/** The sale this demo created that a dispute is about, if any. */
export function saleOfDispute(sales: SaleRegistry, d: { disputed_transactions?: Tx[] }): Sale | undefined {
  for (const t of d.disputed_transactions ?? []) {
    const byTx = t.seller_transaction_id ? sales.bySellerTransaction(t.seller_transaction_id) : undefined;
    if (byTx) return byTx;
    const byNumber = t.invoice_number ? sales.all().find((s) => s.invoiceNumber === t.invoice_number) : undefined;
    if (byNumber) return byNumber;
  }
  return undefined;
}

export interface KnownDisputesDeps {
  reads: PayPalReadCache;
  disputes: DisputeRegistry;
  /** Offline demo: PayPal's (simulated) list is complete and private; no registry. */
  offline: boolean;
}

/**
 * PayPal's dispute list (page 1, 50, cached 30 s) plus registered disputes the list does not
 * return yet, newest first. The list call failing does not hide registered disputes; the error
 * is returned for the caller to report.
 */
export async function knownDisputes(deps: KnownDisputesDeps, paypal: PayPalApi): Promise<{ items: DisputeView[]; listError?: unknown }> {
  let list: Dispute[] = [];
  let listError: unknown;
  try {
    list = ((await deps.reads.listDisputes(paypal, { page_size: 50 })).items ?? []) as Dispute[];
  } catch (err) {
    if (deps.offline) throw err;
    listError = err;
  }
  if (deps.offline) return { items: list.map((d) => ({ dispute: d, detailed: false, inList: true, sources: ["list"] })) };

  const fromList: DisputeView[] = list.map((d) => {
    const entry = deps.disputes.note(d.dispute_id, "list", d);
    // List items may lack the seller transaction ids (PayPal's list gives buyer ids only); use what a read by id gave earlier.
    const dispute = hasSaleIds(d.disputed_transactions) || !hasSaleIds(entry.data?.disputed_transactions) ? d : { ...d, disputed_transactions: entry.data!.disputed_transactions };
    return { dispute, detailed: false, inList: true, sources: [...entry.sources] };
  });
  // After a restart the registry is empty and PayPal's list names no seller transaction, so a
  // listed case would not link to its sale. Read a few such cases by id (cached, bounded).
  const nowMs = Date.now();
  let fills = 0;
  for (let i = 0; i < fromList.length && fills < MAX_DISPUTE_FILL_READS; i++) {
    const v = fromList[i];
    if (!v || hasSaleIds(v.dispute.disputed_transactions)) continue;
    const entry = deps.disputes.get(v.dispute.dispute_id);
    if (entry?.fillTriedAt !== undefined && nowMs - entry.fillTriedAt < DISPUTE_FILL_RETRY_MS) continue;
    fills += 1;
    if (entry) entry.fillTriedAt = nowMs;
    try {
      const d = await deps.reads.getDispute(paypal, v.dispute.dispute_id);
      const noted = deps.disputes.note(v.dispute.dispute_id, "by_id", d, true);
      const tx = noted.data?.disputed_transactions;
      fromList[i] = { dispute: hasSaleIds(tx) ? { ...v.dispute, disputed_transactions: tx } : v.dispute, detailed: false, inList: true, sources: [...noted.sources] };
    } catch {
      // Left as listed; tried again after DISPUTE_FILL_RETRY_MS.
    }
  }
  const listed = new Set(list.map((d) => d.dispute_id));
  // Known from a webhook or by id, but not (yet) in PayPal's list.
  const missing = deps.disputes.all().filter((e) => !listed.has(e.id) && e.sources.some((s) => s !== "list"));
  const read = await Promise.all(
    missing.map(async (e, i): Promise<DisputeView | undefined> => {
      if (i < MAX_DISPUTE_READS_BY_ID) {
        try {
          const d = await deps.reads.getDispute(paypal, e.id);
          const entry = deps.disputes.note(e.id, "by_id", d, true);
          return { dispute: d, detailed: true, inList: false, sources: [...entry.sources] };
        } catch (err) {
          if (err instanceof PayPalApiError && err.status === 404) {
            deps.disputes.notFound(e.id);
            return undefined;
          }
        }
      }
      return e.data ? { dispute: e.data, detailed: false, inList: false, sources: [...e.sources] } : undefined;
    }),
  );
  const items = [...read.filter((x): x is DisputeView => Boolean(x)), ...fromList];
  const time = (v: DisputeView) => v.dispute.create_time ?? deps.disputes.get(v.dispute.dispute_id)?.firstSeen ?? "";
  items.sort((a, b) => time(b).localeCompare(time(a)));
  return { items, ...(listError !== undefined ? { listError } : {}) };
}

/**
 * Reads one dispute by id and registers it (unless offline). Used by "Open a case by ID",
 * the detail route and the webhook follow-up.
 */
export async function readAndRegister(deps: KnownDisputesDeps, paypal: PayPalApi, id: string, source: DisputeSource): Promise<Dispute> {
  const d = await paypal.getDispute(id);
  if (!deps.offline && d?.dispute_id) deps.disputes.note(d.dispute_id, source, d, true);
  return d;
}

/**
 * After a verified CUSTOMER.DISPUTE.CREATED / UPDATED webhook: registers the id at once, then
 * reads the dispute by id in the background (the webhook answer does not wait for PayPal). If
 * that read fails, the id stays registered and the next page load reads it.
 */
export function registerFromWebhook(deps: KnownDisputesDeps, paypal: PayPalApi | undefined, rawId: unknown, log: (msg: string) => void = () => {}): string | undefined {
  const id = parseDisputeId(rawId);
  if (!id || !paypal || deps.offline) return undefined;
  deps.disputes.note(id, "webhook");
  void deps.disputes.background(id, async () => {
    try {
      await readAndRegister(deps, paypal, id, "webhook");
    } catch (err) {
      log(`dispute ${id}: read after webhook failed${err instanceof PayPalApiError ? ` (${err.status}, debug_id ${err.debugId ?? "-"})` : ""}; it will be read on the next page load`);
    }
  });
  return id;
}
