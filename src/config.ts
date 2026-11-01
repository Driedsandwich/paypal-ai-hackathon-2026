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
  /** Use the first X-Forwarded-For hop as the client address (behind a hosting proxy). */
  trustProxy: boolean;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  return n;
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
    aiMaxOutputTokens: num(env, "AI_MAX_OUTPUT_TOKENS", 1200, 100, 8000),
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
    trustProxy: ["1", "true", "yes"].includes((env.TRUST_PROXY ?? "").trim().toLowerCase()),
  };
}

/** PayPal config, or undefined when credentials are not set (the app then runs without PayPal). */
export function loadOptionalPayPalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig | undefined {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return undefined;
  return loadPayPalConfigFromEnv(env);
}
