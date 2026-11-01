import { PayPalClient } from "../../src/paypal/client.js";
import { createFakeFetch, FAKE_CONFIG, type RecordedCall, type Route } from "./fake-fetch.js";

export const SANDBOX = "https://api-m.sandbox.paypal.com";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A PayPal client whose fetch answers the OAuth call and then defers to `route`. */
export function paypalWith(route: Route) {
  const fake = createFakeFetch((c: RecordedCall) => {
    if (c.url.endsWith("/v1/oauth2/token")) {
      return { json: { access_token: "fake-access-token", token_type: "Bearer", expires_in: 32400 } };
    }
    return route(c);
  });
  const client = new PayPalClient({ config: FAKE_CONFIG, fetch: fake.fetch });
  /** Calls except the OAuth token request. */
  const apiCalls = () => fake.calls.filter((c) => !c.url.endsWith("/v1/oauth2/token"));
  return { client, calls: fake.calls, apiCalls };
}

/** A PayPal-style error body (see error_422 in the OpenAPI specs). */
export function paypalError(name: string, debugId: string, issue?: string) {
  return {
    name,
    message: "The requested action could not be performed.",
    debug_id: debugId,
    ...(issue ? { details: [{ issue, description: `${issue} description` }] } : {}),
  };
}
