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

export interface Health {
  paypal: { configured: boolean; env: string | null; webhookConfigured: boolean };
  ai: { provider: string; model: string | null };
  paymentPath: "invoice" | "order";
  fxJpyPerUsd: number;
  limits: { perIp: number; windowMinutes: number; dailyCap: number; maxOutputTokens: number; usedToday: number };
  demo: { notice: string; buyerEmailsConfigured: number; buyers: Array<{ alias: string; email: string }> };
  agStudio: { licensed: boolean };
  banner: string[];
}

export interface Proposal {
  id: string;
  kind: string;
  title: string;
  payload: unknown;
  /** AI-written text for the seller to send by DM; never sent to PayPal. */
  copy_for_dm?: string;
  status: "pending" | "executing" | "executed" | "failed" | "rejected" | "unknown" | "obsolete";
  createdAt: string;
  result?: unknown;
  error?: { message?: string; needsCheck?: boolean; paypal?: ApiErrorBody["paypal"] };
}

export interface Money {
  currency_code: string;
  value: string;
}
