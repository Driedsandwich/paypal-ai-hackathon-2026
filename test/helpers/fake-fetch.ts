import type { FetchLike } from "../../src/paypal/client.js";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type Route = (call: RecordedCall) => { status?: number; json?: unknown } | undefined;

/** A fetch stand-in that records calls and answers from a route table. No network. */
export function createFakeFetch(route: Route): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: RecordedCall = {
      url: input,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const reply = route(call);
    if (!reply) return new Response(JSON.stringify({ name: "NOT_FOUND" }), { status: 404 });
    return new Response(reply.json === undefined ? "" : JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetch, calls };
}

/** Obviously fake credentials for tests only. */
export const FAKE_CONFIG = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  env: "sandbox" as const,
  webhookId: "TEST-WEBHOOK-ID",
};
