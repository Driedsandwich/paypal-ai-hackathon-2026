import type { Dispute } from "./types.js";

// Which seller actions PayPal currently allows on a dispute (F11). Sources (Customer Disputes v1):
// - send-message: "Merchants and customers can only send messages if the
//   dispute_life_cycle_stage value is INQUIRY ... In case the link is not present in the
//   response you can't send a message on the dispute."
// - provide-evidence: "In case the link is not present in the response, you can't provide
//   evidence for the dispute."
// - accept-claim: allowed options are in `allowed_response_options.accept_claim`.
// The OpenAPI file names no rel values for these HATEOAS links, so a link counts when its rel
// is the action name (send_message / send-message) or its href path ends with the action path.

export type DisputeAction = "send_message" | "provide_evidence" | "accept_claim";

export interface ActionVerdict {
  allowed: boolean;
  /** Why not, in words a seller understands (empty when allowed). */
  reason: string;
}

const PATHS: Record<DisputeAction, string> = {
  send_message: "send-message",
  provide_evidence: "provide-evidence",
  accept_claim: "accept-claim",
};

export function hasActionLink(d: Pick<Dispute, "links">, action: DisputeAction): boolean {
  const seg = PATHS[action];
  return (d.links ?? []).some((l) => {
    if (l.rel === action || l.rel === seg) return true;
    try {
      return new URL(l.href, "https://api-m.paypal.com").pathname.replace(/\/+$/, "").endsWith(`/${seg}`);
    } catch {
      return false;
    }
  });
}

export function disputeActions(d: Dispute): Record<DisputeAction, ActionVerdict> {
  const stage = d.dispute_life_cycle_stage ?? "unknown";
  const yes: ActionVerdict = { allowed: true, reason: "" };
  const sendMessage: ActionVerdict =
    stage !== "INQUIRY"
      ? { allowed: false, reason: `PayPal only allows messages while the dispute is an inquiry; this one is at stage ${stage}.` }
      : !hasActionLink(d, "send_message")
        ? { allowed: false, reason: "PayPal does not offer sending a message on this dispute right now." }
        : yes;
  const provideEvidence: ActionVerdict = hasActionLink(d, "provide_evidence")
    ? yes
    : { allowed: false, reason: "PayPal is not asking for evidence on this dispute right now (no provide-evidence action)." };
  const acceptClaim: ActionVerdict =
    hasActionLink(d, "accept_claim") || d.allowed_response_options?.accept_claim !== undefined
      ? yes
      : { allowed: false, reason: "PayPal does not offer accepting the claim on this dispute right now." };
  return { send_message: sendMessage, provide_evidence: provideEvidence, accept_claim: acceptClaim };
}

/** The allowed actions as a list, for the UI and the model. */
export function allowedActionList(d: Dispute): DisputeAction[] {
  const v = disputeActions(d);
  return (Object.keys(v) as DisputeAction[]).filter((a) => v[a].allowed);
}
