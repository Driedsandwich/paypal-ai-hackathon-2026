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
  aiDailyCap: number;
  fxJpyPerUsd: number;
  sellerBusinessName: string | undefined;
  demoBuyerEmails: string[];
  agStudioLicensed: boolean;
  /**
   * Number of trusted proxies in front of the app (TRUST_PROXY_HOPS). 0 = use the socket
   * address; N = use the N-th X-Forwarded-For entry from the right (1 on Render).
   */
  trustProxyHops: number;
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
    fxJpyPerUsd: num(env, "FX_JPY_PER_USD", 150, 1, 10_000),
    sellerBusinessName: (env.SELLER_BUSINESS_NAME ?? "").trim() || undefined,
    demoBuyerEmails: (env.DEMO_BUYER_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    agStudioLicensed: (env.AG_STUDIO_LICENSE ?? "").trim() !== "",
    trustProxyHops: num(env, "TRUST_PROXY_HOPS", 0, 0, 10, true),
  };
}

/** PayPal config, or undefined when credentials are not set (the app then runs without PayPal). */
export function loadOptionalPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig | undefined {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return undefined;
  return loadPayPalConfigFromEnv(env);
}
