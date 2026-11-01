import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../../src/server.js";

export interface Visitor {
  get(p: string, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }>;
  post(p: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; headers: Headers; body: any }>;
  head(p: string): Promise<{ status: number; headers: Headers }>;
  /** The demo session cookie this visitor holds (after the first API call). */
  cookie(): string | undefined;
}

/** A browser-like client with its own cookie jar (one demo session). */
export function visitor(base: string): Visitor {
  let cookie: string | undefined;
  const remember = (h: Headers) => {
    const set = h.get("set-cookie");
    if (set) cookie = set.split(";")[0];
  };
  const withCookie = (headers: Record<string, string>) => (cookie ? { ...headers, Cookie: cookie } : headers);
  const read = async (r: Response) => ((r.headers.get("content-type") ?? "").includes("json") ? ((await r.json()) as any) : await r.text());
  return {
    async get(p, headers = {}) {
      const r = await fetch(`${base}${p}`, { headers: withCookie(headers) });
      remember(r.headers);
      return { status: r.status, headers: r.headers, body: await read(r) };
    },
    async post(p, body = {}, headers = { "Content-Type": "application/json" }) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: withCookie(headers), body: typeof body === "string" ? body : JSON.stringify(body) });
      remember(r.headers);
      return { status: r.status, headers: r.headers, body: await read(r) };
    },
    async head(p) {
      const r = await fetch(`${base}${p}`, { method: "HEAD", headers: withCookie({}) });
      return { status: r.status, headers: r.headers };
    },
    cookie: () => cookie,
  };
}

/** Starts the app on a random port. Returns the base URL, a first visitor and a closer. */
export async function startApp(options: AppOptions = {}): Promise<{ server: Server; base: string; close: () => Promise<void> } & Visitor> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { server, base, close, ...visitor(base) };
}
