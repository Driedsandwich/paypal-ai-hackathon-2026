import { parseAiProviderName, type AiProviderName } from "./ai/index.js";
import { loadPayPalConfigFromEnv, type PayPalConfig } from "./paypal/config.js";

export type PaymentPath = "invoice" | "order";

/** App settings read from environment variables (names listed in .env.example). */
export interface AppSettings {
  port: number;
  /** Base URL where this app is reachable; used for Orders v2 return/cancel URLs. */
  publicBaseUrl: string;
  paymentPath: PaymentPath;
  aiProvider: AiProviderName;
  aiMaxOutputTokens: number;
  aiRateLimitPerIp: number;
  aiRateLimitWindowMinutes: number;
  /** Model calls per UTC day, whole server; every tool step and retry counts (AI_DAILY_CAP). */
  aiDailyCap: number;
  /** Invalid AI requests per address per AI window before refusing (AI_INVALID_RATE_LIMIT_PER_IP). */
  aiInvalidRateLimitPerIp: number;
  fxJpyPerUsd: number;
  sellerBusinessName: string | undefined;
  demoBuyerEmails: string[];
  agStudioLicensed: boolean;
  /**
   * Number of trusted proxies in front of the app (TRUST_PROXY_HOPS). 0 = use the socket
   * address; N = use the N-th X-Forwarded-For entry from the right (1 on Render).
   */
  trustProxyHops: number;
  /** Concurrent in-flight API/webhook requests before new ones get 503 (MAX_CONCURRENT_REQUESTS). */
  maxConcurrentRequests: number;
  /** Proposals created per session and per address per window (PROPOSAL_RATE_LIMIT). */
  proposalRateLimit: number;
  /** Approvals per session and per address per window (APPROVAL_RATE_LIMIT). */
  approvalRateLimit: number;
  /** Requests that read from PayPal, per address per window (PAYPAL_READ_RATE_LIMIT). */
  paypalReadRateLimit: number;
  /** Window for the three limits above (RATE_LIMIT_WINDOW_MINUTES). */
  rateLimitWindowMinutes: number;
  /** PayPal write calls per UTC day, whole server (PAYPAL_DAILY_WRITE_CAP). */
  paypalDailyWriteCap: number;
  /** Seconds a PayPal list read (invoices, disputes) is cached (LIST_CACHE_SECONDS). */
  listCacheSeconds: number;
  /** Webhook requests per address per minute (WEBHOOK_RATE_LIMIT). */
  webhookRateLimit: number;
  /** Webhook requests per minute, whole server (WEBHOOK_GLOBAL_RATE_LIMIT). */
  webhookGlobalRateLimit: number;
  /** A session may seed demo data once per this many minutes (SEED_SESSION_INTERVAL_MINUTES). */
  seedSessionIntervalMinutes: number;
  /** Demo-data seeds per UTC day, whole server (SEED_DAILY_CAP). */
  seedDailyCap: number;
  /** Approved actions running at the same time (EXECUTION_CONCURRENCY). */
  executionConcurrency: number;
  /**
   * PAYPAL_OFFLINE_DEMO=true: simulate PayPal in memory (one private world per visitor) instead
   * of calling the sandbox. For keyless demos and screenshots; wins over PayPal credentials.
   */
  paypalOfflineDemo: boolean;
}

function bool(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = (env[name] ?? "").trim().toLowerCase();
  if (v === "" || v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  throw new Error(`${name} must be true or false (got "${env[name]}")`);
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

/** Settings that are no longer read; the server logs a hint when one is set. */
export function legacySettingWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TRUST_PROXY ?? "").trim() ? ["TRUST_PROXY is no longer used: set TRUST_PROXY_HOPS (0 = socket address, 1 = one proxy such as Render)."] : [];
}

export function parsePaymentPath(value: string | undefined): PaymentPath {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "invoice") return "invoice";
  if (v === "order") return "order";
  throw new Error(`PAYMENT_PATH must be "invoice" or "order" (got "${value}")`);
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): AppSettings {
  const port = num(env, "PORT", 3000, 1, 65535);
  return {
    port,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").trim() || `http://localhost:${port}`,
    paymentPath: parsePaymentPath(env.PAYMENT_PATH),
    aiProvider: parseAiProviderName(env.AI_PROVIDER),
    aiMaxOutputTokens: num(env, "AI_MAX_OUTPUT_TOKENS", 2000, 100, 8000),
    aiRateLimitPerIp: num(env, "AI_RATE_LIMIT_PER_IP", 20, 1, 10_000),
    aiRateLimitWindowMinutes: num(env, "AI_RATE_LIMIT_WINDOW_MINUTES", 10, 1, 1440),
    aiDailyCap: num(env, "AI_DAILY_CAP", 300, 1, 1_000_000),
    aiInvalidRateLimitPerIp: num(env, "AI_INVALID_RATE_LIMIT_PER_IP", 20, 1, 10_000, true),
    fxJpyPerUsd: num(env, "FX_JPY_PER_USD", 150, 1, 10_000),
    sellerBusinessName: (env.SELLER_BUSINESS_NAME ?? "").trim() || undefined,
    demoBuyerEmails: (env.DEMO_BUYER_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    agStudioLicensed: (env.AG_STUDIO_LICENSE ?? "").trim() !== "",
    trustProxyHops: num(env, "TRUST_PROXY_HOPS", 0, 0, 10, true),
    maxConcurrentRequests: num(env, "MAX_CONCURRENT_REQUESTS", 20, 1, 10_000, true),
    proposalRateLimit: num(env, "PROPOSAL_RATE_LIMIT", 20, 1, 10_000, true),
    approvalRateLimit: num(env, "APPROVAL_RATE_LIMIT", 20, 1, 10_000, true),
    paypalReadRateLimit: num(env, "PAYPAL_READ_RATE_LIMIT", 60, 1, 100_000, true),
    rateLimitWindowMinutes: num(env, "RATE_LIMIT_WINDOW_MINUTES", 10, 1, 1440),
    paypalDailyWriteCap: num(env, "PAYPAL_DAILY_WRITE_CAP", 100, 1, 1_000_000, true),
    listCacheSeconds: num(env, "LIST_CACHE_SECONDS", 30, 0, 3600),
    webhookRateLimit: num(env, "WEBHOOK_RATE_LIMIT", 30, 1, 100_000, true),
    webhookGlobalRateLimit: num(env, "WEBHOOK_GLOBAL_RATE_LIMIT", 120, 1, 1_000_000, true),
    seedSessionIntervalMinutes: num(env, "SEED_SESSION_INTERVAL_MINUTES", 60, 1, 10_080),
    seedDailyCap: num(env, "SEED_DAILY_CAP", 10, 1, 10_000, true),
    executionConcurrency: num(env, "EXECUTION_CONCURRENCY", 2, 1, 100, true),
    paypalOfflineDemo: bool(env, "PAYPAL_OFFLINE_DEMO"),
  };
}

/** PayPal config, or undefined when credentials are not set (the app then runs without PayPal). */
export function loadOptionalPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig | undefined {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return undefined;
  return loadPayPalConfigFromEnv(env);
}
