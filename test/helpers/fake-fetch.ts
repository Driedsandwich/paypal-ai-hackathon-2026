import type { FetchLike } from "../../src/paypal/client.js";

export interface RecordedFormPart {
  name: string;
  /** Text content (files are decoded as UTF-8 for inspection). */
  value: string;
  filename?: string;
  type?: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Set when the body was multipart FormData. */
  form?: RecordedFormPart[];
}

export type Route = (
  call: RecordedCall,
) => { status?: number; json?: unknown; headers?: Record<string, string> } | undefined;

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
    if (init?.body instanceof FormData) {
      call.form = [];
      for (const [name, value] of init.body.entries()) {
        if (typeof value === "string") call.form.push({ name, value });
        else {
          call.form.push({
            name,
            value: await value.text(),
            ...(value.name && value.name !== "blob" ? { filename: value.name } : {}),
            type: value.type,
          });
        }
      }
    }
    calls.push(call);
    const reply = route(call);
    if (!reply) return new Response(JSON.stringify({ name: "NOT_FOUND" }), { status: 404 });
    const status = reply.status ?? 200;
    const noBody = status === 204 || reply.json === undefined;
    return new Response(noBody ? null : JSON.stringify(reply.json), {
      status,
      headers: { ...(noBody ? {} : { "Content-Type": "application/json" }), ...(reply.headers ?? {}) },
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

/** Builds strings at runtime so tracked test files contain no literal email addresses. */
export const fakeEmail = (local: string) => [local, "@", "example", ".", "com"].join("");
