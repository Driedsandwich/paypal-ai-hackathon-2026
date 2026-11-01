import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiProviderFromEnv, FakeAiProvider } from "./ai/index.js";
import { offlineReply } from "./ai/offline.js";
import type { AiProvider } from "./ai/provider.js";
import { Agent } from "./agent/tasks.js";
import { legacySettingWarnings, loadOptionalPayPalConfig, loadSettings, type AppSettings } from "./config.js";
import { EventLog } from "./events/log.js";
import { handleApi, healthData, type ApiDeps } from "./http/api.js";
import { paypalReturnPage, serveStatic } from "./http/static.js";
import { readBody, sendError, sendJson } from "./http/util.js";
import { AiLimiter } from "./limits/rate-limit.js";
import { PayPalApiError, PayPalClient, handlePayPalWebhook, type PayPalConfig } from "./paypal/index.js";
import { createPayPalExecutor } from "./proposals/actions.js";
import { ProposalStore } from "./proposals/store.js";

const MAX_WEBHOOK_BODY = 1024 * 1024;
const ORDER_TOKEN = /^[A-Za-z0-9]{1,36}$/;

export interface AppOptions {
  settings?: AppSettings;
  /** Undefined runs the app without PayPal (UI shows a banner). */
  paypalConfig?: PayPalConfig;
  paypal?: PayPalClient;
  ai?: AiProvider;
  events?: EventLog;
  proposals?: ProposalStore;
  limiter?: AiLimiter;
  /** Directory with the built UI (index.html). */
  staticDir?: string;
  log?: (msg: string) => void;
}

/** Wires dependencies with safe defaults (offline AI, no PayPal). */
export function buildDeps(options: AppOptions = {}): ApiDeps & { log: (msg: string) => void; staticDir: string | undefined } {
  const settings = options.settings ?? loadSettings({});
  const paypal = options.paypal ?? (options.paypalConfig ? new PayPalClient({ config: options.paypalConfig }) : undefined);
  const ai = options.ai ?? new FakeAiProvider([offlineReply]);
  const log = options.log ?? (() => {});
  const proposals =
    options.proposals ??
    new ProposalStore(
      createPayPalExecutor(() => {
        if (!paypal) throw new Error("PayPal is not configured");
        return paypal;
      }),
      { describeError: (err) => (err instanceof PayPalApiError ? { message: "PayPal could not complete the request", paypal: err.toSafeJSON() } : { message: err instanceof Error ? err.message : String(err) }) },
    );
  return {
    settings,
    paypalConfig: options.paypalConfig,
    paypal,
    ai,
    agent: new Agent(ai, {
      fxJpyPerUsd: settings.fxJpyPerUsd,
      maxOutputTokens: settings.aiMaxOutputTokens,
      publicBaseUrl: settings.publicBaseUrl,
      ...(settings.sellerBusinessName ? { sellerBusinessName: settings.sellerBusinessName } : {}),
    }),
    events: options.events ?? new EventLog(),
    proposals,
    limiter:
      options.limiter ??
      new AiLimiter({ perIpMax: settings.aiRateLimitPerIp, windowMs: settings.aiRateLimitWindowMinutes * 60_000, dailyCap: settings.aiDailyCap }),
    log,
    staticDir: options.staticDir,
  };
}

/** HTTP app on node:http: JSON API under /api, PayPal webhook, payment-link return pages, static UI. */
export function createApp(options: AppOptions = {}): Server {
  const deps = buildDeps(options);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/health" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: healthData(deps) });
      }
      if (url.pathname === "/webhooks/paypal") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "Use POST" } }, { Allow: "POST" });
        const rawBody = await readBody(req, MAX_WEBHOOK_BODY);
        const result = await handlePayPalWebhook(
          { headers: req.headers, rawBody },
          {
            webhookId: deps.paypalConfig?.webhookId,
            verify: (r) => {
              if (!deps.paypal) throw new Error("PayPal is not configured");
              return deps.paypal.verifyWebhookSignature(r);
            },
            onEvent: (event) => {
              const logged = deps.events.record(event);
              if (logged) deps.log(`webhook ${logged.eventType}: ${logged.summary}`);
            },
          },
        );
        return sendJson(res, result.status, result.body);
      }
      if (url.pathname.startsWith("/api/")) {
        if (await handleApi(req, res, url, deps)) return;
        return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Unknown API route" } });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
      }
      if (url.pathname === "/paypal/return" || url.pathname === "/paypal/cancel") {
        const token = url.searchParams.get("token") ?? "";
        if (url.pathname === "/paypal/return" && deps.paypal && ORDER_TOKEN.test(token)) {
          // The buyer approved a payment link: queue the capture for the seller's approval.
          const already = deps.proposals.list().some((p) => p.kind === "capture_order" && (p.payload as { orderId: string }).orderId === token);
          if (!already) deps.proposals.propose("capture_order", `Capture payment for order ${token}`, { orderId: token });
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(paypalReturnPage(url.pathname === "/paypal/return" ? "return" : "cancel"));
      }
      return serveStatic(deps.staticDir, url.pathname, res);
    } catch (err) {
      return sendError(res, err, deps.log);
    }
  });
}

/** Reads live sandbox state once at startup so problems with credentials show up in the log. */
async function warmUp(deps: ApiDeps, log: (msg: string) => void): Promise<void> {
  if (!deps.paypal) return;
  try {
    const [invoices, disputes] = await Promise.all([deps.paypal.listInvoices({ page_size: 20, total_required: true }), deps.paypal.listDisputes({ page_size: 20 })]);
    log(`PayPal sandbox: ${invoices.total_items ?? invoices.items?.length ?? 0} invoices, ${disputes.items?.length ?? 0} recent disputes`);
  } catch (err) {
    log(`PayPal warm-up failed: ${err instanceof PayPalApiError ? `${err.status} debug_id=${err.debugId ?? "-"}` : String(err)}`);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const settings = loadSettings();
  const paypalConfig = loadOptionalPayPalConfig();
  const ai = createAiProviderFromEnv(process.env, settings.aiMaxOutputTokens);
  const log = (msg: string) => console.log(`[okuri] ${msg}`);
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  const options: AppOptions = { settings, ai, staticDir, log, ...(paypalConfig ? { paypalConfig } : {}) };
  for (const w of legacySettingWarnings()) log(`warning: ${w}`);
  const app = createApp(options);
  app.listen(settings.port, () => {
    log(`Listening on http://localhost:${settings.port}`);
    log(`PayPal: ${paypalConfig ? paypalConfig.env : "not configured"} | AI: ${ai.name}${ai.model ? ` (${ai.model})` : ""} | payment path: ${settings.paymentPath}`);
    void warmUp(buildDeps(options), log);
  });
}
