import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Per-visitor demo sessions (no login). The server sets a random, httpOnly, SameSite=Lax
 * cookie (Secure when the app is served over https). Proposals belong to the session that
 * created them; nobody else can list, approve or reject them.
 */
export const SESSION_COOKIE = "okuri_sid";
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const MAX_AGE_SECONDS = 30 * 86_400;

export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** The session id from the Cookie header, if present and well-formed. */
export function readSessionId(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    if (SESSION_ID.test(value)) return value;
  }
  return undefined;
}

export function sessionCookie(id: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Whether to mark the cookie Secure: when PUBLIC_BASE_URL is https, when the socket is TLS,
 * or (behind trusted proxies) when the proxy reports https in X-Forwarded-Proto.
 */
export function isSecureRequest(req: IncomingMessage, publicBaseUrl: string, trustProxyHops: number): boolean {
  if (/^https:\/\//i.test(publicBaseUrl)) return true;
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (trustProxyHops > 0) {
    const proto = req.headers["x-forwarded-proto"];
    const values = (Array.isArray(proto) ? proto.join(",") : (proto ?? "")).split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
    return values.at(-1) === "https";
  }
  return false;
}

/** Returns the caller's session id, creating one (and setting the cookie) when missing. */
export function ensureSession(req: IncomingMessage, res: ServerResponse, secure: boolean): string {
  const existing = readSessionId(req);
  if (existing) return existing;
  const id = newSessionId();
  res.setHeader("Set-Cookie", sessionCookie(id, secure));
  return id;
}
