import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { AgentOutputError } from "../agent/json-task.js";
import { LimitError } from "../limits/limits.js";
import { AiBudgetError } from "../limits/rate-limit.js";
import { MoneyError } from "../money.js";
import { maskEmailsDeep } from "../privacy/mask.js";
import { AiTimeoutError } from "../ai/ai-sdk-provider.js";
import { PayPalApiError, PayPalTimeoutError } from "../paypal/client.js";
import { ProposalError } from "../proposals/store.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Every JSON response passes through here; email addresses in it are masked (F3). */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(maskEmailsDeep(body)));
}

export function ok(res: ServerResponse, data: unknown, status = 200): void {
  sendJson(res, status, { ok: true, data });
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, "body_too_large", `Request body is larger than ${maxBytes} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Reads a JSON object body. POST bodies must be application/json: browsers cannot send
 * that cross-site without a CORS preflight, which this server never grants (CSRF guard
 * for the approve endpoint).
 */
/** Errors that mean "the request itself was invalid" (counted by the invalid-AI-request limit). */
export function isInvalidInputError(err: unknown): boolean {
  if (err instanceof ZodError || err instanceof MoneyError) return true;
  return err instanceof HttpError && [400, 413, 415].includes(err.status);
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "unsupported_media_type", "Send the request body as application/json");
  const text = await readBody(req, maxBytes);
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "invalid_json", "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Maps any error to { ok: false, error } without leaking request headers, keys or stack traces. */
export function sendError(res: ServerResponse, err: unknown, log: (msg: string) => void = () => {}): void {
  if (err instanceof HttpError) {
    return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message, ...err.extra } }, err.headers);
  }
  if (err instanceof ZodError) {
    const issues = err.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(body)"}: ${i.message}`);
    return sendJson(res, 400, { ok: false, error: { code: "invalid_input", message: "Some fields are missing or invalid", issues } });
  }
  if (err instanceof AiBudgetError) {
    return sendJson(res, 429, { ok: false, error: { code: "daily_cap_reached", message: err.message, retryAfterSeconds: err.retryAfterSeconds } }, { "Retry-After": String(err.retryAfterSeconds) });
  }
  if (err instanceof LimitError) {
    return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds } }, { "Retry-After": String(err.retryAfterSeconds) });
  }
  if (err instanceof MoneyError) {
    return sendJson(res, 400, { ok: false, error: { code: "invalid_amount", message: err.message } });
  }
  if (err instanceof ProposalError) {
    const status = { not_found: 404, not_pending: 409, store_full: 503, too_many_pending: 429 }[err.code];
    return sendJson(res, status, { ok: false, error: { code: `proposal_${err.code}`, message: err.message } }, status === 503 ? { "Retry-After": "60" } : {});
  }
  if (err instanceof PayPalApiError) {
    const status = err.status === 404 ? 404 : err.status === 400 || err.status === 422 ? 422 : 502;
    log(`PayPal error ${err.status} debug_id=${err.debugId ?? "-"}`);
    return sendJson(res, status, { ok: false, error: { code: "paypal_error", message: "PayPal could not complete the request", paypal: err.toSafeJSON() } });
  }
  if (err instanceof PayPalTimeoutError) {
    log(`PayPal timeout ${err.method} ${err.path}`);
    return sendJson(res, 504, { ok: false, error: { code: "paypal_timeout", message: `${err.message}. Please try again.` } });
  }
  if (err instanceof AiTimeoutError) {
    return sendJson(res, 504, { ok: false, error: { code: "ai_timeout", message: `${err.message}. Please try again.` } });
  }
  if (err instanceof AgentOutputError) {
    return sendJson(res, 502, { ok: false, error: { code: "ai_output_invalid", message: err.message, issues: err.issues.slice(0, 10) } });
  }
  const name = err instanceof Error ? err.name : "Error";
  log(`internal error: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  if (/^AI_|APICallError|RetryError/.test(name)) {
    return sendJson(res, 502, { ok: false, error: { code: "ai_provider_error", message: "The AI provider could not answer. Please try again later." } });
  }
  return sendJson(res, 500, { ok: false, error: { code: "internal_error", message: "Internal error" } });
}
