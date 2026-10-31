export type PayPalEnv = "sandbox" | "live";

export const PAYPAL_BASE_URLS: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  webhookId?: string;
}

export function parsePayPalEnv(value: string | undefined): PayPalEnv {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "" || v === "sandbox") return "sandbox";
  if (v === "live") return "live";
  throw new Error(`PAYPAL_ENV must be "sandbox" or "live" (got "${value}")`);
}

export function baseUrlFor(env: PayPalEnv): string {
  return PAYPAL_BASE_URLS[env];
}

/** Reads PayPal settings from environment variables. Throws if credentials are missing. */
export function loadPayPalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const clientId = env.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = env.PAYPAL_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example)");
  }
  const webhookId = env.PAYPAL_WEBHOOK_ID || undefined;
  return {
    clientId,
    clientSecret,
    env: parsePayPalEnv(env.PAYPAL_ENV),
    ...(webhookId ? { webhookId } : {}),
  };
}
