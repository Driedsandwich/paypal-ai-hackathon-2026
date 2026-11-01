// Small typed wrapper around the JSON API ({ ok, data | error }).

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: string[];
  retryAfterSeconds?: number;
  paypal?: { message: string; status: number; name?: string; debugId?: string; issues?: string[] };
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: ApiErrorBody) {
    super(body.message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  let json: { ok: boolean; data?: T; error?: ApiErrorBody };
  try {
    json = await res.json();
  } catch {
    throw new ApiError(res.status, { code: "bad_response", message: `Unexpected response (${res.status})` });
  }
  if (!json.ok) throw new ApiError(res.status, json.error ?? { code: "unknown", message: "Request failed" });
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
};

export interface ProviderInfo {
  provider: string;
  model: string | null;
}

export interface Health {
  paypal: { configured: boolean; env: string | null; offline: boolean; webhookConfigured: boolean };
  ai: ProviderInfo & { fallback?: ProviderInfo };
  countries: Array<{ code: string; name: string }>;
  paymentPath: "invoice" | "order";
  fxJpyPerUsd: number;
  demoLimits: { windowMinutes: number; proposals: number; approvals: number; paypalReads: number; paypalWritesToday: number; paypalDailyWriteCap: number };
  limits: { perIp: number; windowMinutes: number; dailyCap: number; maxOutputTokens: number; usedToday: number };
  demo: { notice: string; buyerEmailsConfigured: number; buyers: Array<{ alias: string; email: string }> };
  agStudio: { licensed: boolean; licenseKey?: string };
  banner: string[];
}

export type ProposalStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "unknown" | "obsolete" | "expired";

export interface Proposal {
  id: string;
  kind: string;
  title: string;
  payload: unknown;
  /** AI-written text for the seller to send by DM; never sent to PayPal. */
  copy_for_dm?: string;
  sale_id?: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  result?: unknown;
  error?: { message?: string; needsCheck?: boolean; paypal?: ApiErrorBody["paypal"]; follow_up_proposal_id?: string };
  /** Approve response only: a new proposal offered after PayPal refused this one (e.g. evidence type OTHER). */
  follow_up_proposal?: Proposal;
  /** Approve response only, dispute actions: the case as PayPal shows it right after the action. */
  dispute?: unknown;
  dispute_warning?: string;
  warnings?: string[];
}

export interface Money {
  currency_code: string;
  value: string;
}

export type GeneratedBy = { provider: string; model?: string; fallback_from?: { provider: string; model?: string; reason: string } };

export type JourneyAction = "prepare_invoice" | "remind" | "add_tracking" | "build_evidence" | "simulate_payment" | "simulate_dispute" | "simulate_delivery";

export interface Journey {
  id: string;
  title_ja?: string;
  title_en: string;
  buyer: string;
  country: string;
  country_name: string;
  amount?: Money;
  path: "invoice" | "order";
  invoice_id?: string;
  invoice_number?: string;
  invoice_status?: string;
  order_id?: string;
  capture_id?: string;
  /** No carrier when the tracking was read back from PayPal after a restart (Orders v2 does not return it). */
  tracking?: { carrier?: string; number: string; at: string };
  created_at: string;
  drafted_by?: GeneratedBy;
  listing?: { title: string; description: string; price: Money; quantity: number; shipping?: Money };
  stage: "draft" | "invoiced" | "paid" | "shipped" | "delivered";
  current_step: number;
  steps: Array<{ n: number; name: string; state: "done" | "current" | "todo"; label: string }>;
  callout?: { step: number; kind: "proposal"; proposal: Proposal } | { step: number; kind: "action"; actions: JourneyAction[]; problem?: Proposal };
  hint?: { step: number; text: string };
  dispute?: {
    dispute_id: string;
    status?: string;
    reason?: string;
    stage?: string;
    amount?: Money;
    due?: string;
    open: boolean;
    from_step: number;
    proposals: Proposal[];
    /** False while PayPal's list does not return the case yet. */
    in_paypal_list?: boolean;
    /** Known only when the case was just read by id: false = PayPal offers no seller action. */
    seller_action_available?: boolean;
    notice?: string;
  };
  can_simulate_dispute: boolean;
  activity: Array<{ at: string; text: string }>;
}

export interface JourneysData {
  journeys: Journey[];
  counts: { draft: number; invoiced: number; paid: number; shipped: number; disputed: number };
  pending_count: number;
  warnings: string[];
}

/** "Claude", "Gemini", … for a provider name. */
export function providerLabel(provider: string | undefined): string {
  switch (provider) {
    case "anthropic":
      return "Claude";
    case "google":
      return "Gemini";
    case "openai":
      return "OpenAI";
    case "fake":
      return "Offline AI";
    default:
      return provider ?? "AI";
  }
}

/** "Item USD $110.00 + Shipping USD $18.00" (the S3 callout breakdown). */
export function itemPlusShipping(item: Money | undefined, shipping: Money | undefined): string {
  return `Item ${money(item)} + Shipping ${money(shipping)}`;
}

/** a + b for display (same currency), in minor units so cents do not drift. */
export function addMoney(a: Money | undefined, b: Money | undefined): Money | undefined {
  if (!a || !b) return a ?? b;
  const digits = ["JPY", "HUF", "TWD"].includes(a.currency_code) ? 0 : 2;
  const minor = Math.round(Number(a.value) * 10 ** digits) + Math.round(Number(b.value) * 10 ** digits);
  return { currency_code: a.currency_code, value: (minor / 10 ** digits).toFixed(digits) };
}

export function money(m: Money | undefined): string {
  if (!m) return "";
  const n = Number(m.value);
  if (!Number.isFinite(n)) return `${m.currency_code} ${m.value}`;
  const symbol = m.currency_code === "USD" ? "$" : m.currency_code === "JPY" ? "¥" : m.currency_code === "EUR" ? "€" : m.currency_code === "GBP" ? "£" : "";
  const digits = ["JPY", "HUF", "TWD"].includes(m.currency_code) ? 0 : 2;
  return `${m.currency_code} ${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "09:12" today, "Oct 28 09:12" otherwise. */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? hm : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${hm}`;
}
