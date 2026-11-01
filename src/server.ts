import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiProviderFromEnv, createFallbackProviderFromEnv, FakeAiProvider, withFallback } from "./ai/index.js";
import { withAiBudget } from "./ai/budget.js";
import { offlineReply } from "./ai/offline.js";
import type { AiProvider } from "./ai/provider.js";
import { Agent } from "./agent/tasks.js";
import { legacySettingWarnings, loadOptionalPayPalConfig, loadSettings, type AppSettings } from "./config.js";
import { EventLog } from "./events/log.js";
import { handleApi, healthData, type ApiDeps } from "./http/api.js";
import { handlePayPalReturn } from "./http/paypal-return.js";
import { serveStatic } from "./http/static.js";
import { readBody, sendError, sendJson } from "./http/util.js";
import { AiLimiter } from "./limits/rate-limit.js";
import { DemoLimits } from "./limits/demo-limits.js";
import { PayPalReadCache } from "./paypal/read-cache.js";
import { clientAddress, limitKey } from "./http/client-address.js";
import { ensureSession, isSecureRequest } from "./http/session.js";
import { PayPalApiError, PayPalClient, PayPalTimeoutError, handlePayPalWebhook, type PayPalConfig } from "./paypal/index.js";
import { createPayPalExecutor } from "./proposals/actions.js";
import { OrderRegistry } from "./proposals/order-registry.js";
import { ReminderLedger } from "./proposals/reminder-ledger.js";
import { DemoBuyers } from "./demo/buyers.js";
import { ProposalObsoleteError, ProposalPolicyError, ProposalStore } from "./proposals/store.js";
import { MoneyError } from "./money.js";
import { SaleRegistry } from "./journeys/sales.js";
import { DisputeRegistry, registerFromWebhook } from "./journeys/disputes.js";
import { OfflineWorlds, offlineBuyerEmails } from "./journeys/offline-world.js";
import type { PayPalApi } from "./paypal/offline.js";

const MAX_WEBHOOK_BODY = 1024 * 1024;
/** Node server limits (F8): whole request headers within 20 s, whole request within 30 s. */
export const HEADERS_TIMEOUT_MS = 20_000;
export const REQUEST_TIMEOUT_MS = 30_000;

export interface AppOptions {
  settings?: AppSettings;
  /** Undefined runs the app without PayPal (UI shows a banner). */
  paypalConfig?: PayPalConfig;
  paypal?: PayPalApi;
  ai?: AiProvider;
  /** Second provider used when the primary fails or its budget is used up (AI_FALLBACK_PROVIDER). */
  aiFallback?: AiProvider;
  /** Display info about primary and fallback AI providers (for the header). */
  aiInfo?: ApiDeps["aiInfo"];
  sales?: SaleRegistry;
  /** Known dispute ids (list, webhooks, by id). */
  disputes?: DisputeRegistry;
  events?: EventLog;
  proposals?: ProposalStore;
  limiter?: AiLimiter;
  orders?: OrderRegistry;
  limits?: DemoLimits;
  /** Directory with the built UI (index.html). */
  staticDir?: string;
  log?: (msg: string) => void;
}

/** What a visitor may see about a failed execution: no free-form internal messages. */
export function describeExecutionError(err: unknown, log: (msg: string) => void = () => {}): Record<string, unknown> {
  if (err instanceof PayPalApiError) return { message: "PayPal could not complete the request", paypal: err.toSafeJSON() };
  if (err instanceof PayPalTimeoutError) {
    return err.write
      ? { message: `${err.message}. The action may or may not have happened: check the PayPal sandbox before preparing it again.`, needsCheck: true }
      : { message: `${err.message}. Nothing was changed at PayPal; you can try again.` };
  }
  if (err instanceof ProposalObsoleteError || err instanceof ProposalPolicyError || err instanceof MoneyError) return { message: err.message };
  log(`execution error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return { message: "The action could not be completed (internal error)." };
}

/** Wires dependencies with safe defaults (offline AI, no PayPal). */
export function buildDeps(options: AppOptions = {}): ApiDeps & { log: (msg: string) => void; staticDir: string | undefined } {
  const settings = options.settings ?? loadSettings({});
  const offlineDemo = settings.paypalOfflineDemo;
  const paypal = offlineDemo ? undefined : (options.paypal ?? (options.paypalConfig ? new PayPalClient({ config: options.paypalConfig }) : undefined));
  const limiter =
    options.limiter ??
    new AiLimiter({ perIpMax: settings.aiRateLimitPerIp, windowMs: settings.aiRateLimitWindowMinutes * 60_000, dailyCap: settings.aiDailyCap, invalidMax: settings.aiInvalidRateLimitPerIp });
  const log = options.log ?? (() => {});
  // Every model call is debited from the daily AI budget (F9); the fallback has its own.
  const primary = withAiBudget(options.ai ?? new FakeAiProvider([offlineReply]), limiter);
  let ai = primary;
  let aiInfo = options.aiInfo;
  if (options.aiFallback) {
    const fallbackLimiter = new AiLimiter({ perIpMax: settings.aiRateLimitPerIp, windowMs: settings.aiRateLimitWindowMinutes * 60_000, dailyCap: settings.aiFallbackDailyCap });
    limiter.setFallback(fallbackLimiter);
    ai = withFallback(primary, withAiBudget(options.aiFallback, fallbackLimiter), log);
    aiInfo ??= {
      primary: { provider: primary.name, model: primary.model ?? null },
      fallback: { provider: options.aiFallback.name, model: options.aiFallback.model ?? null },
    };
  }
  // Offline demo without DEMO_BUYER_EMAILS: three made-up buyers whose addresses never resolve.
  const buyers = new DemoBuyers(offlineDemo && settings.demoBuyerEmails.length === 0 ? offlineBuyerEmails() : settings.demoBuyerEmails);
  const sales = options.sales ?? new SaleRegistry();
  const orders = options.orders ?? new OrderRegistry();
  const reminders = new ReminderLedger();
  let offline: OfflineWorlds | undefined;
  const proposals =
    options.proposals ??
    new ProposalStore(
      createPayPalExecutor(
        (owner) => {
          const client = offline ? offline.peek(owner) : paypal;
          if (!client) throw new Error("PayPal is not configured");
          return client;
        },
        { buyers, orders, reminders },
      ),
      { describeError: (err) => describeExecutionError(err, log), isUnknownOutcome: (err) => err instanceof PayPalTimeoutError && err.write },
    );
  if (offlineDemo) {
    offline = new OfflineWorlds({
      registry: sales,
      proposals,
      buyers,
      ...(settings.sellerBusinessName ? { sellerBusinessName: settings.sellerBusinessName } : {}),
      draftedBy: { provider: ai.name, ...(ai.model ? { model: ai.model } : {}) },
    });
  }
  return {
    settings,
    paypalConfig: offlineDemo ? undefined : options.paypalConfig,
    paypal,
    offline,
    sales,
    disputes: options.disputes ?? new DisputeRegistry(),
    ...(aiInfo ? { aiInfo } : {}),
    ai,
    agent: new Agent(ai, {
      fxJpyPerUsd: settings.fxJpyPerUsd,
      maxOutputTokens: settings.aiMaxOutputTokens,
      publicBaseUrl: settings.publicBaseUrl,
      ...(settings.sellerBusinessName ? { sellerBusinessName: settings.sellerBusinessName } : {}),
    }),
    events: options.events ?? new EventLog(),
    proposals,
    limiter,
    buyers,
    orders,
    reminders,
    limits: options.limits ?? new DemoLimits(settings),
    // Offline worlds are per visitor: never share a cached list between them.
    reads: new PayPalReadCache(offlineDemo ? 0 : settings.listCacheSeconds * 1000),
    log,
    staticDir: options.staticDir,
  };
}

/** HTTP app on node:http: JSON API under /api, PayPal webhook, payment-link return pages, static UI. */
export function createApp(options: AppOptions = {}): Server {
  const deps = buildDeps(options);
  let inFlight = 0;
  const server = createServer(async (req, res) => {
    let counted = false;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if ((url.pathname === "/health" || url.pathname === "/api/health") && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: healthData(deps) });
      }
      // Admission limit for work that can wait on PayPal or the AI model (F8).
      if (url.pathname.startsWith("/api/") || url.pathname === "/webhooks/paypal" || url.pathname === "/paypal/return") {
        if (inFlight >= deps.settings.maxConcurrentRequests) {
          return sendJson(res, 503, { ok: false, error: { code: "server_busy", message: "The demo server is busy. Please try again in a few seconds." } }, { "Retry-After": "2" });
        }
        inFlight += 1;
        counted = true;
      }
      if (url.pathname === "/webhooks/paypal") {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "Use POST" } }, { Allow: "POST" });
        // Limit before reading the body or calling PayPal's verification API (F2).
        deps.limits.takeWebhook(limitKey(clientAddress(req, deps.settings.trustProxyHops)));
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
              if (logged) {
                deps.reads.invalidate(); // e.g. an invoice was paid: show it on the next read
                deps.log(`webhook ${logged.eventType}: ${logged.summary}`);
                // New cases can be missing from PayPal's dispute list for minutes: remember the id.
                if (logged.category === "dispute") registerFromWebhook({ reads: deps.reads, disputes: deps.disputes, offline: Boolean(deps.offline) }, deps.paypal, logged.resourceId, deps.log);
              }
            },
            isDuplicate: (id) => deps.events.hasSeen(id),
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
        return await handlePayPalReturn(req, res, url, deps, () => deps.limits.takeRead(limitKey(clientAddress(req, deps.settings.trustProxyHops))));
      }
      // Give the visitor a demo session as soon as the UI loads, before any API call. Only on
      // the HTML entry (no file extension, served no-cache): cacheable assets must never carry
      // a Set-Cookie that a shared cache could hand to the next visitor.
      if (!path.extname(url.pathname)) ensureSession(req, res, isSecureRequest(req, deps.settings.publicBaseUrl, deps.settings.trustProxyHops));
      return serveStatic(deps.staticDir, url.pathname, res);
    } catch (err) {
      return sendError(res, err, deps.log);
    } finally {
      if (counted) inFlight -= 1;
    }
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
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
  const fallback = createFallbackProviderFromEnv(process.env, settings.aiMaxOutputTokens);
  const log = (msg: string) => console.log(`[okuri] ${msg}`);
  const staticDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  const options: AppOptions = { settings, ai, staticDir, log, ...(paypalConfig ? { paypalConfig } : {}), ...(fallback.provider ? { aiFallback: fallback.provider } : {}) };
  for (const w of legacySettingWarnings()) log(`warning: ${w}`);
  if (fallback.warning) log(`warning: ${fallback.warning}`);
  const app = createApp(options);
  app.listen(settings.port, () => {
    log(`Listening on http://localhost:${settings.port}`);
    if (fallback.provider) log(`AI fallback: ${fallback.provider.name}${fallback.provider.model ? ` (${fallback.provider.model})` : ""}, ${settings.aiFallbackDailyCap} calls/day`);
    log(`PayPal: ${settings.paypalOfflineDemo ? "offline demo (simulated in memory)" : paypalConfig ? paypalConfig.env : "not configured"} | AI: ${ai.name}${ai.model ? ` (${ai.model})` : ""} | payment path: ${settings.paymentPath}`);
    void warmUp(buildDeps(options), log);
  });
}
