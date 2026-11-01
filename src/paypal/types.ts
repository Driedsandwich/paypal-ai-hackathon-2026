// Request/response shapes for the PayPal REST APIs used by this app.
// Field names are copied from PayPal's published OpenAPI specifications
// (github.com/paypal/paypal-rest-api-specifications, the source of the API
// reference on developer.paypal.com). Only the fields this app uses are typed;
// index signatures keep the rest of PayPal's response available.

export interface Money {
  currency_code: string;
  value: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

// ---------- Invoicing v2 ----------

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_PAID"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "UNPAID"
  | "PAYMENT_PENDING"
  | "AUTO_CANCELLED"
  | "PAID_EXTERNAL"
  | "REFUNDED_EXTERNAL"
  | "SHARED";

/** `invoice_detail` (currency_code is the only required field). */
export interface InvoiceDetail {
  currency_code: string;
  reference?: string;
  note?: string;
  terms_and_conditions?: string;
  memo?: string;
  invoice_number?: string;
  /** YYYY-MM-DD */
  invoice_date?: string;
  payment_term?: { term_type?: string; due_date?: string };
}

/** `invoicer_info` */
export interface InvoicerInfo {
  business_name?: string;
  email_address?: string;
  website?: string;
  additional_notes?: string;
  logo_url?: string;
}

/** `recipient_info` (billing_info is `billing_info`). */
export interface RecipientInfo {
  billing_info?: {
    business_name?: string;
    email_address?: string;
    language?: string;
    additional_info?: string;
  };
}

/** `item`: name, quantity and unit_amount are required. */
export interface InvoiceItem {
  name: string;
  description?: string;
  /** Decimal as string, max 14 chars. */
  quantity: string;
  unit_amount: Money;
  unit_of_measure?: "QUANTITY" | "HOURS" | "AMOUNT";
}

/** Body of POST /v2/invoicing/invoices (`invoice`, detail required). */
export interface InvoiceDraft {
  detail: InvoiceDetail;
  invoicer?: InvoicerInfo;
  primary_recipients?: RecipientInfo[];
  items: InvoiceItem[];
  [key: string]: unknown;
}

export interface InvoicePaymentTransaction {
  type?: string;
  /** PayPal transaction ID for PAYPAL payments; used for Add Tracking. */
  payment_id?: string;
  payment_date?: string;
  method?: string;
  amount?: Money;
}

/** `invoice` as returned by GET /v2/invoicing/invoices/{id}. */
export interface Invoice {
  id: string;
  status?: InvoiceStatus;
  detail: InvoiceDetail & { metadata?: { recipient_view_url?: string; invoicer_view_url?: string; [k: string]: unknown } };
  invoicer?: InvoicerInfo;
  primary_recipients?: RecipientInfo[];
  items?: InvoiceItem[];
  amount?: { currency_code?: string; value?: string };
  due_amount?: Money;
  payments?: { paid_amount?: Money; transactions?: InvoicePaymentTransaction[] };
  links?: PayPalLink[];
  [key: string]: unknown;
}

/** `invoices` (GET /v2/invoicing/invoices). */
export interface InvoiceList {
  total_pages?: number;
  total_items?: number;
  items?: Invoice[];
  links?: PayPalLink[];
}

/**
 * `notification` (body of /send and /remind). PayPal's references for both calls say that
 * user-provided `subject` and `note` "will not be honored", so the client only sends the flags
 * (see InvoiceSendFlags); the AI note for a new invoice goes in `invoice.detail.note`.
 */
export interface InvoiceNotification {
  subject?: string;
  note?: string;
  send_to_invoicer?: boolean;
  send_to_recipient?: boolean;
  additional_recipients?: string[];
}

/** What this app sends to /send and /remind. */
export type InvoiceSendFlags = Pick<InvoiceNotification, "send_to_recipient" | "send_to_invoicer">;

export interface ListInvoicesParams {
  page?: number;
  page_size?: number;
  total_required?: boolean;
  fields?: string;
}

/** Result of createDraftInvoice: PayPal answers 201 with either the invoice or a `self` link. */
export interface CreatedInvoice {
  id: string;
  invoice?: Invoice;
  href?: string;
}

// ---------- Orders v2 ----------

/** Subset of the Orders v2 create request. */
export interface CreateOrderRequest {
  intent: "CAPTURE" | "AUTHORIZE";
  purchase_units: Array<{
    reference_id?: string;
    description?: string;
    custom_id?: string;
    invoice_id?: string;
    amount: { currency_code: string; value: string; breakdown?: { item_total?: Money; shipping?: Money } };
    items?: Array<{ name: string; quantity: string; unit_amount: Money; description?: string; category?: string }>;
  }>;
  payment_source?: {
    paypal?: {
      /** `paypal_wallet.email_address`: "The email address of the PayPal account holder." */
      email_address?: string;
      experience_context?: {
        brand_name?: string;
        locale?: string;
        shipping_preference?: "GET_FROM_FILE" | "NO_SHIPPING" | "SET_PROVIDED_ADDRESS";
        user_action?: "CONTINUE" | "PAY_NOW";
        return_url?: string;
        cancel_url?: string;
      };
    };
  };
  [key: string]: unknown;
}

export interface OrderResponse {
  id: string;
  status: string;
  links?: PayPalLink[];
  purchase_units?: Array<{
    reference_id?: string;
    payments?: { captures?: Array<{ id: string; status: string; amount?: Money }> };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** Body of POST /v2/checkout/orders/{id}/track (`order_tracker_request`). */
export interface OrderTrackerRequest {
  capture_id: string;
  tracking_number: string;
  /** A `shipment_carrier` enum value, e.g. JPN_JAPAN_POST, or OTHER. */
  carrier: string;
  /** Only when carrier is OTHER. */
  carrier_name_other?: string;
  notify_payer?: boolean;
}

// ---------- Add Tracking v1 (/v1/shipping/trackers-batch) ----------

/** One entry of `tracker_collection.trackers` (status and transaction_id required). */
export interface ShippingTracker {
  transaction_id: string;
  tracking_number?: string;
  status: "SHIPPED" | "ON_HOLD" | "DELIVERED" | "CANCELLED" | "LOCAL_PICKUP";
  /** A `carrier` enum value, e.g. JPN_JAPAN_POST, or OTHER. */
  carrier?: string;
  carrier_name_other?: string;
  notify_buyer?: boolean;
  shipment_date?: string;
}

/** `batch_tracker_collection` */
export interface TrackersBatchResponse {
  tracker_identifiers?: Array<{ transaction_id: string; tracking_number?: string }>;
  errors?: Array<{ name?: string; message?: string; debug_id?: string; details?: unknown[] }>;
  links?: PayPalLink[];
}

// ---------- Customer Disputes v1 ----------

export type DisputeState =
  | "OPEN_INQUIRIES"
  | "REQUIRED_ACTION"
  | "REQUIRED_OTHER_PARTY_ACTION"
  | "UNDER_PAYPAL_REVIEW"
  | "APPEALABLE"
  | "RESOLVED";

/** `dispute_info` (list item) */
export interface DisputeSummary {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_state?: DisputeState;
  dispute_amount?: Money;
  dispute_life_cycle_stage?: string;
  seller_response_due_date?: string;
  links?: PayPalLink[];
  [key: string]: unknown;
}

/** `dispute_search` */
export interface DisputeList {
  items?: DisputeSummary[];
  links?: PayPalLink[];
}

export interface DisputeMessage {
  posted_by?: "BUYER" | "SELLER" | "ARBITER";
  time_posted?: string;
  content?: string;
}

/** `dispute` (subset). */
export interface Dispute extends DisputeSummary {
  disputed_transactions?: Array<{
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    create_time?: string;
    transaction_status?: string;
    gross_amount?: Money;
    invoice_number?: string;
    custom?: string;
    [key: string]: unknown;
  }>;
  messages?: DisputeMessage[];
  evidences?: unknown[];
  /** `allowed_response_options` (acknowledge_return_item, accept_claim, make_offer). */
  allowed_response_options?: {
    accept_claim?: { accept_claim_types?: string[] };
    make_offer?: unknown;
    acknowledge_return_item?: unknown;
  };
  [key: string]: unknown;
}

export interface ListDisputesParams {
  dispute_state?: DisputeState;
  disputed_transaction_id?: string;
  page_size?: number;
  next_page_token?: string;
  start_time?: string;
}

/** `tracking_info` inside `evidence_info`. */
export interface DisputeTrackingInfo {
  carrier_name: string;
  carrier_name_other?: string;
  tracking_url?: string;
  tracking_number: string;
}

/** One `evidence` item for provide-evidence. */
export interface DisputeEvidence {
  evidence_type: string;
  evidence_info?: { tracking_info?: DisputeTrackingInfo[]; refund_ids?: Array<{ refund_id: string }> };
  notes?: string;
}

export interface EvidenceFile {
  name: string;
  contentType: "application/pdf" | "image/png" | "image/jpeg" | "image/gif";
  data: Uint8Array;
}

/** `subsequent_action` */
export interface SubsequentAction {
  links?: PayPalLink[];
}
