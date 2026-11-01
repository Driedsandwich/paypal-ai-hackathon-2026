import { randomBytes } from "node:crypto";
import { formatMinor, multiplyMinor, toMinor } from "../money.js";
import { PayPalApiError, type PayPalClient } from "./client.js";
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

/**
 * The PayPal calls the app makes. The real `PayPalClient` implements them over REST; the
 * offline simulator below implements them in memory for the keyless demo.
 */
export type PayPalApi = Pick<
  PayPalClient,
  | "createOrder"
  | "getOrder"
  | "captureOrder"
  | "addOrderTracking"
  | "generateNextInvoiceNumber"
  | "createDraftInvoice"
  | "sendInvoice"
  | "remindInvoice"
  | "getInvoice"
  | "listInvoices"
  | "addTrackersBatch"
  | "listDisputes"
  | "getDispute"
  | "provideDisputeEvidence"
  | "sendDisputeMessage"
  | "acceptDisputeClaim"
  | "verifyWebhookSignature"
>;

const BASE = "https://offline.invalid";
const MAX_RECORDS = 200;

function id(prefix: string, len = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(len);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${prefix}${out}`;
}

function notFound(what: string): PayPalApiError {
  return new PayPalApiError(`${what} not found (offline simulator)`, 404, { name: "RESOURCE_NOT_FOUND", debug_id: "offline" });
}

function unprocessable(issue: string, description: string): PayPalApiError {
  return new PayPalApiError(description, 422, { name: "UNPROCESSABLE_ENTITY", debug_id: "offline", details: [{ issue, description }] });
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function disputeLinks(d: Dispute): PayPalLink[] {
  const links: PayPalLink[] = [{ href: `${BASE}/v1/customer/disputes/${d.dispute_id}`, rel: "self", method: "GET" }];
  if (d.status === "RESOLVED") return links;
  if (d.dispute_life_cycle_stage === "INQUIRY") links.push({ href: `${BASE}/v1/customer/disputes/${d.dispute_id}/send-message`, rel: "send_message", method: "POST" });
  if (d.status === "WAITING_FOR_SELLER_RESPONSE") links.push({ href: `${BASE}/v1/customer/disputes/${d.dispute_id}/provide-evidence`, rel: "provide_evidence", method: "POST" });
  links.push({ href: `${BASE}/v1/customer/disputes/${d.dispute_id}/accept-claim`, rel: "accept_claim", method: "POST" });
  return links;
}

/**
 * In-memory stand-in for the PayPal sandbox, used only when PAYPAL_OFFLINE_DEMO is on. One
 * instance per demo session, so visitors do not see each other's simulated data. Nothing
 * leaves the process; ids are random and clearly not PayPal's. It follows the shapes the real
 * client returns (the subset the app reads), not PayPal's full behaviour.
 */
export class OfflinePayPal implements PayPalApi {
  private readonly invoices = new Map<string, Invoice>();
  private readonly orders = new Map<string, OrderResponse & { request: CreateOrderRequest }>();
  private readonly disputes = new Map<string, Dispute>();
  private readonly trackers: ShippingTracker[] = [];
  private nextNumber = 1001;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private guard(map: Map<string, unknown>): void {
    if (map.size >= MAX_RECORDS) throw unprocessable("LIMIT_REACHED", "The offline simulator holds at most 200 records per visitor.");
  }

  // ---------- Orders v2 ----------

  async createOrder(order: CreateOrderRequest): Promise<OrderResponse> {
    this.guard(this.orders);
    const oid = id("OFF-O-", 12);
    const created = {
      id: oid,
      status: "PAYER_ACTION_REQUIRED",
      request: structuredClone(order),
      purchase_units: order.purchase_units.map((u) => ({ ...(u.reference_id ? { reference_id: u.reference_id } : {}), ...(u.custom_id ? { custom_id: u.custom_id } : {}), amount: u.amount })),
      links: [{ href: `${BASE}/checkoutnow?token=${oid}`, rel: "payer-action", method: "GET" }],
    };
    this.orders.set(oid, created);
    return this.publicOrder(created);
  }

  private publicOrder(o: OrderResponse & { request?: unknown }): OrderResponse {
    const { request: _r, ...rest } = o;
    return structuredClone(rest) as OrderResponse;
  }

  async getOrder(orderId: string): Promise<OrderResponse> {
    const o = this.orders.get(orderId);
    if (!o) throw notFound(`Order ${orderId}`);
    return this.publicOrder(o);
  }

  async captureOrder(orderId: string): Promise<OrderResponse> {
    const o = this.orders.get(orderId);
    if (!o) throw notFound(`Order ${orderId}`);
    if (o.status !== "APPROVED") throw unprocessable("ORDER_NOT_APPROVED", "The buyer has not approved this order yet.");
    o.status = "COMPLETED";
    const unit = o.purchase_units?.[0];
    if (unit) unit.payments = { captures: [{ id: id("OFF-C-", 12), status: "COMPLETED", ...(o.request.purchase_units[0] ? { amount: { currency_code: o.request.purchase_units[0].amount.currency_code, value: o.request.purchase_units[0].amount.value } } : {}) }] };
    return this.publicOrder(o);
  }

  async addOrderTracking(orderId: string, tracker: OrderTrackerRequest): Promise<OrderResponse> {
    const o = this.orders.get(orderId);
    if (!o) throw notFound(`Order ${orderId}`);
    const capture = o.purchase_units?.[0]?.payments?.captures?.find((c) => c.id === tracker.capture_id);
    if (!capture) throw unprocessable("CAPTURE_NOT_FOUND", "No completed capture with this id on the order.");
    return this.publicOrder(o);
  }

  // ---------- Invoicing v2 ----------

  async generateNextInvoiceNumber(): Promise<string> {
    return `OFF-${this.nextNumber++}`;
  }

  async createDraftInvoice(draft: InvoiceDraft): Promise<CreatedInvoice> {
    this.guard(this.invoices);
    const iid = id("OFF2-", 16);
    let totalMinor = 0;
    for (const item of draft.items) totalMinor += multiplyMinor(toMinor(item.unit_amount.value, item.unit_amount.currency_code), Number(item.quantity));
    const shipping = draft.amount?.breakdown?.shipping?.amount;
    if (shipping) totalMinor += toMinor(shipping.value, shipping.currency_code);
    const currency = draft.detail.currency_code;
    const invoice: Invoice = {
      ...structuredClone(draft),
      id: iid,
      status: "DRAFT",
      detail: { ...structuredClone(draft.detail), invoice_date: draft.detail.invoice_date ?? today(this.now()) },
      amount: { currency_code: currency, value: formatMinor(totalMinor, currency), ...(shipping ? { breakdown: { shipping: { amount: shipping } } } : {}) },
      due_amount: { currency_code: currency, value: formatMinor(totalMinor, currency) },
    };
    this.invoices.set(iid, invoice);
    return { id: iid, invoice: structuredClone(invoice) };
  }

  async sendInvoice(invoiceId: string, _flags: InvoiceSendFlags = {}): Promise<PayPalLink | undefined> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    if (inv.status !== "DRAFT") throw unprocessable("INVALID_INVOICE_STATUS", "Only draft invoices can be sent.");
    inv.status = "SENT";
    const href = `${BASE}/invoice/p/#${invoiceId}`;
    inv.detail.metadata = { recipient_view_url: href };
    return { href, rel: "payer-view", method: "GET" };
  }

  async remindInvoice(invoiceId: string): Promise<void> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    if (inv.status !== "SENT" && inv.status !== "UNPAID" && inv.status !== "PARTIALLY_PAID") throw unprocessable("INVALID_INVOICE_STATUS", "Only unpaid invoices can be reminded.");
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    return structuredClone(inv);
  }

  async listInvoices(params: ListInvoicesParams = {}): Promise<InvoiceList> {
    const all = [...this.invoices.values()].reverse();
    const size = params.page_size ?? 20;
    const page = params.page ?? 1;
    return { total_items: all.length, total_pages: Math.max(1, Math.ceil(all.length / size)), items: structuredClone(all.slice((page - 1) * size, page * size)) };
  }

  async addTrackersBatch(trackers: ShippingTracker[]): Promise<TrackersBatchResponse> {
    const known = new Set([...this.invoices.values()].flatMap((i) => (i.payments?.transactions ?? []).map((t) => t.payment_id)));
    const ok: TrackersBatchResponse["tracker_identifiers"] = [];
    for (const t of trackers) {
      if (!known.has(t.transaction_id)) throw unprocessable("INVALID_TRANSACTION_ID", "No payment with this transaction id (offline simulator).");
      this.trackers.push(structuredClone(t));
      ok.push({ transaction_id: t.transaction_id, ...(t.tracking_number ? { tracking_number: t.tracking_number } : {}) });
    }
    return { tracker_identifiers: ok, errors: [] };
  }

  // ---------- Disputes v1 ----------

  async listDisputes(_params: ListDisputesParams = {}): Promise<DisputeList> {
    return { items: [...this.disputes.values()].reverse().map((d) => structuredClone({ ...d, links: disputeLinks(d) })) };
  }

  async getDispute(disputeId: string): Promise<Dispute> {
    const d = this.disputes.get(disputeId);
    if (!d) throw notFound(`Dispute ${disputeId}`);
    return structuredClone({ ...d, links: disputeLinks(d) });
  }

  async provideDisputeEvidence(disputeId: string, evidences: DisputeEvidence[], _files: EvidenceFile[] = []): Promise<SubsequentAction> {
    const d = this.disputes.get(disputeId);
    if (!d) throw notFound(`Dispute ${disputeId}`);
    d.evidences = [...(d.evidences ?? []), ...structuredClone(evidences)];
    d.status = "UNDER_REVIEW";
    d.dispute_state = "UNDER_PAYPAL_REVIEW";
    d.update_time = this.now().toISOString();
    return { links: [{ href: `${BASE}/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }] };
  }

  async sendDisputeMessage(disputeId: string, message: string): Promise<SubsequentAction> {
    const d = this.disputes.get(disputeId);
    if (!d) throw notFound(`Dispute ${disputeId}`);
    d.messages = [...(d.messages ?? []), { posted_by: "SELLER", time_posted: this.now().toISOString(), content: message }];
    d.status = "WAITING_FOR_BUYER_RESPONSE";
    d.dispute_state = "REQUIRED_OTHER_PARTY_ACTION";
    d.update_time = this.now().toISOString();
    return { links: [{ href: `${BASE}/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }] };
  }

  async acceptDisputeClaim(disputeId: string, _note: string): Promise<SubsequentAction> {
    const d = this.disputes.get(disputeId);
    if (!d) throw notFound(`Dispute ${disputeId}`);
    d.status = "RESOLVED";
    d.dispute_state = "RESOLVED";
    d.update_time = this.now().toISOString();
    return { links: [{ href: `${BASE}/v1/customer/disputes/${disputeId}`, rel: "self", method: "GET" }] };
  }

  /** No webhooks reach the simulator. */
  async verifyWebhookSignature(): Promise<boolean> {
    return false;
  }

  // ---------- What a buyer would do (offline demo buttons) ----------

  /** The buyer pays a sent invoice; returns the new transaction id. */
  simulateInvoicePayment(invoiceId: string, at: Date = this.now()): string {
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    if (inv.status !== "SENT" && inv.status !== "UNPAID") throw unprocessable("INVALID_INVOICE_STATUS", `This invoice is ${inv.status}; only sent, unpaid invoices can be paid.`);
    const tx = id("OFFTX", 12);
    inv.status = "PAID";
    inv.due_amount = { currency_code: inv.detail.currency_code, value: formatMinor(0, inv.detail.currency_code) };
    inv.payments = { paid_amount: inv.amount?.value ? { currency_code: inv.detail.currency_code, value: inv.amount.value } : undefined, transactions: [{ payment_id: tx, payment_date: today(at), method: "PAYPAL", ...(inv.amount?.value ? { amount: { currency_code: inv.detail.currency_code, value: inv.amount.value } } : {}) }] } as Invoice["payments"];
    return tx;
  }

  /** The buyer approves a payment link at PayPal. */
  simulateOrderApproval(orderId: string): void {
    const o = this.orders.get(orderId);
    if (!o) throw notFound(`Order ${orderId}`);
    if (o.status !== "PAYER_ACTION_REQUIRED" && o.status !== "CREATED") throw unprocessable("ORDER_ALREADY_APPROVED", `This order is ${o.status}.`);
    o.status = "APPROVED";
  }

  /** The buyer opens an item-not-received case on a paid invoice. */
  simulateDispute(invoiceId: string, opts: { stage?: "INQUIRY" | "CHARGEBACK"; message?: string; at?: Date } = {}): Dispute {
    this.guard(this.disputes);
    const inv = this.invoices.get(invoiceId);
    if (!inv) throw notFound(`Invoice ${invoiceId}`);
    const tx = inv.payments?.transactions?.[0]?.payment_id;
    if (!tx) throw unprocessable("NOT_PAID", "A dispute needs a paid invoice.");
    if ([...this.disputes.values()].some((d) => d.disputed_transactions?.some((t) => t.seller_transaction_id === tx) && d.status !== "RESOLVED")) {
      throw unprocessable("DISPUTE_EXISTS", "This sale already has an open dispute.");
    }
    const at = opts.at ?? this.now();
    const due = new Date(at.getTime() + 10 * 86_400_000);
    const did = id("PP-D-OFF", 8);
    const d: Dispute = {
      dispute_id: did,
      create_time: at.toISOString(),
      update_time: at.toISOString(),
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_state: "REQUIRED_ACTION",
      dispute_amount: inv.amount?.value ? { currency_code: inv.detail.currency_code, value: inv.amount.value } : undefined,
      dispute_life_cycle_stage: opts.stage ?? "INQUIRY",
      seller_response_due_date: due.toISOString(),
      disputed_transactions: [{ seller_transaction_id: tx, invoice_number: inv.detail.invoice_number, gross_amount: inv.amount?.value ? { currency_code: inv.detail.currency_code, value: inv.amount.value } : undefined }],
      messages: [{ posted_by: "BUYER", time_posted: at.toISOString(), content: opts.message ?? "Hello, my parcel has not arrived yet. Can you check the shipment?" }],
    } as Dispute;
    this.disputes.set(did, d);
    return structuredClone(d);
  }

  /** Test and seeding helper: backdate an invoice. */
  setInvoiceDate(invoiceId: string, date: string): void {
    const inv = this.invoices.get(invoiceId);
    if (inv) inv.detail.invoice_date = date;
  }
}
