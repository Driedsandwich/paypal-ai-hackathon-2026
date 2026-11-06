import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "./api.js";
import type { Proposal } from "../proposals/store.js";
import { paypalReturnPage, type ReturnOutcome } from "./static.js";

const ORDER_TOKEN = /^[A-Za-z0-9]{1,36}$/;

/** A capture proposal in one of these states means the order needs no new one. */
const CAPTURE_IN_PROGRESS = new Set<Proposal["status"]>(["pending", "executing", "executed", "unknown"]);

/**
 * Queues a capture proposal for an order created by this server, in the session that created
 * it, only when PayPal reports the order APPROVED. De-duplicated through the order registry,
 * independent of the proposal store. Returns the existing or new proposal.
 */
export function queueCapture(deps: ApiDeps, orderId: string): Proposal | undefined {
  const known = deps.orders.get(orderId);
  if (!known) return undefined;
  const existing = known.captureProposalId ? deps.proposals.peek(known.captureProposalId) : undefined;
  if (existing && CAPTURE_IN_PROGRESS.has(existing.status)) return existing;
  const saleId = deps.sales.byOrder(orderId)?.id;
  const proposal = deps.proposals.propose("capture_order", `Capture payment for order ${orderId}`, { orderId }, { owner: known.owner, ...(saleId ? { saleId } : {}) });
  known.captureProposalId = proposal.id;
  return proposal;
}

/**
 * GET/HEAD /paypal/return and /paypal/cancel: the pages PayPal sends the buyer to.
 * HEAD has no side effects. GET on /paypal/return accepts only order ids this server created,
 * checks the order with PayPal, and says "approved" only when PayPal does.
 */
export async function handlePayPalReturn(req: IncomingMessage, res: ServerResponse, url: URL, deps: ApiDeps, beforeLookup: () => void = () => {}): Promise<void> {
  const send = (outcome: ReturnOutcome) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : paypalReturnPage(outcome));
  };
  if (url.pathname === "/paypal/cancel") return send("cancel");
  if (req.method === "HEAD") return send("unknown_order");

  const token = url.searchParams.get("token") ?? "";
  if (!deps.paypal || !ORDER_TOKEN.test(token) || !deps.orders.get(token)) return send("unknown_order");

  try {
    beforeLookup(); // per-address read limit, before calling PayPal
  } catch {
    return send("rate_limited");
  }
  let status: string;
  try {
    status = (await deps.paypal.getOrder(token)).status;
  } catch {
    return send("check_failed");
  }
  if (status === "COMPLETED") return send("completed");
  if (status !== "APPROVED") return send("not_approved");
  try {
    queueCapture(deps, token);
  } catch {
    // Queue full: PayPal still reports the approval; the seller can capture from the journey or Approvals.
  }
  return send("approved");
}
