import { describe, expect, it } from "vitest";
import { DemoBuyers } from "../src/demo/buyers.js";
import { createPayPalExecutor, TRACKING_NOT_AUTHORIZED_MESSAGE } from "../src/proposals/actions.js";
import { ProposalStore } from "../src/proposals/store.js";
import { describeExecutionError } from "../src/server.js";
import { paypalWith } from "./helpers/paypal.js";

// Pass 5, item 4: on the hosted demo, POST /v1/shipping/trackers-batch answered 403
// NOT_AUTHORIZED because the sandbox app has no shipping trackers scope.
const NOT_AUTHORIZED = { name: "NOT_AUTHORIZED", message: "Authorization failed due to insufficient permissions.", debug_id: "a1b2c3d4e5f60", details: [{ issue: "PERMISSION_DENIED", description: "You do not have permission to access or perform operations on this resource." }] };

function storeWith(status: number, json: unknown) {
  const pp = paypalWith((c) => (c.url.endsWith("/v1/shipping/trackers-batch") ? { status, json } : undefined));
  const execute = createPayPalExecutor(() => pp.client, { buyers: new DemoBuyers([]) });
  const store = new ProposalStore(execute, { describeError: (e) => describeExecutionError(e) });
  const p = store.propose("add_invoice_tracking", "Add tracking", { trackers: [{ transaction_id: "8MC585209K746392H", tracking_number: "EJ123456789JP", status: "SHIPPED", carrier: "JPN_JAPAN_POST" }] }, { owner: "s" });
  return { store, p };
}

describe("tracking for invoice payments without the shipping trackers permission", () => {
  it("maps 403 to a clear message on the proposal and keeps PayPal's debug_id", async () => {
    const { store, p } = storeWith(403, NOT_AUTHORIZED);
    const done = await store.approve(p.id, "s");
    expect(done.status).toBe("failed");
    expect(done.error).toEqual({
      message: TRACKING_NOT_AUTHORIZED_MESSAGE,
      paypal: expect.objectContaining({ status: 403, name: "NOT_AUTHORIZED", debugId: "a1b2c3d4e5f60" }),
    });
    expect(TRACKING_NOT_AUTHORIZED_MESSAGE).toBe("PayPal did not allow tracking for this invoice payment: the PayPal app needs the shipping trackers permission");
  });

  it("leaves other PayPal errors as they were", async () => {
    const { store, p } = storeWith(422, { name: "UNPROCESSABLE_ENTITY", debug_id: "0f0f0f0f0f0f0" });
    const done = await store.approve(p.id, "s");
    expect(done.error).toMatchObject({ message: "PayPal could not complete the request", paypal: { status: 422, debugId: "0f0f0f0f0f0f0" } });
  });
});
