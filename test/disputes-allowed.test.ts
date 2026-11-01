import { afterEach, describe, expect, it } from "vitest";
import { DemoBuyers } from "../src/demo/buyers.js";
import { agentTools } from "../src/agent/tools.js";
import { loadSettings } from "../src/config.js";
import { disputeActions, hasActionLink } from "../src/paypal/dispute-actions.js";
import type { Dispute } from "../src/paypal/types.js";
import { ProposalStore } from "../src/proposals/store.js";
import { FAKE_CONFIG } from "./helpers/fake-fetch.js";
import { startApp } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

const link = (id: string, action: string, rel = action.replace(/-/g, "_")) => ({ href: `${SANDBOX}/v1/customer/disputes/${id}/${action}`, rel, method: "POST" });

describe("disputeActions", () => {
  it("allows a message only in INQUIRY with the send-message link", () => {
    const inquiry: Dispute = { dispute_id: "D", dispute_life_cycle_stage: "INQUIRY", links: [link("D", "send-message"), link("D", "provide-evidence"), link("D", "accept-claim")] };
    expect(Object.values(disputeActions(inquiry)).every((v) => v.allowed)).toBe(true);

    const chargeback: Dispute = { dispute_id: "D", dispute_life_cycle_stage: "CHARGEBACK", links: [link("D", "send-message"), link("D", "provide-evidence")] };
    const v = disputeActions(chargeback);
    expect(v.send_message).toEqual({ allowed: false, reason: expect.stringMatching(/only allows messages while the dispute is an inquiry; this one is at stage CHARGEBACK/) });
    expect(v.provide_evidence.allowed).toBe(true);
    expect(v.accept_claim.allowed).toBe(false);

    expect(disputeActions({ dispute_id: "D", dispute_life_cycle_stage: "INQUIRY" }).send_message.reason).toMatch(/does not offer sending a message/);
  });

  it("matches action links by rel or by path, and accept-claim by allowed_response_options", () => {
    expect(hasActionLink({ links: [link("D", "provide-evidence", "something_else")] }, "provide_evidence")).toBe(true);
    expect(hasActionLink({ links: [{ href: "https://x.invalid/other", rel: "provide_evidence" }] }, "provide_evidence")).toBe(true);
    expect(hasActionLink({ links: [link("D", "provide-evidence-extra", "x")] }, "provide_evidence")).toBe(false);
    expect(disputeActions({ dispute_id: "D", allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND"] } } }).accept_claim.allowed).toBe(true);
    const resolved = disputeActions({ dispute_id: "D", status: "RESOLVED", dispute_life_cycle_stage: "INQUIRY", links: [] });
    expect(Object.values(resolved).some((x) => x.allowed)).toBe(false);
  });
});

/** A sandbox where the dispute's state can change between calls. */
function sandboxWithDispute(state: { dispute: Dispute }) {
  return paypalWith((c) => {
    const u = c.url.replace(SANDBOX, "");
    if (u === `/v1/customer/disputes/${state.dispute.dispute_id}` && c.method === "GET") return { json: state.dispute };
    if (/\/(send-message|provide-evidence|accept-claim)$/.test(u)) return { json: { links: [] } };
    return undefined;
  });
}

describe("dispute proposals follow PayPal's allowed actions", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });
  async function start(state: { dispute: Dispute }) {
    const pp = sandboxWithDispute(state);
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({}) });
    close = app.close;
    return { ...app, pp };
  }

  it("a CHARGEBACK gets an evidence proposal but no message proposal", async () => {
    const state = { dispute: { dispute_id: "PP-D-CB", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", dispute_life_cycle_stage: "CHARGEBACK", links: [link("PP-D-CB", "provide-evidence")] } as Dispute };
    const { post } = await start(state);
    const res = await post("/api/disputes/PP-D-CB/evidence-pack", { tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP" } });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.proposals)).toEqual(["provide_evidence"]);
    expect(res.body.data.allowed_actions.send_message).toMatchObject({ allowed: false, reason: expect.stringMatching(/CHARGEBACK/) });
  });

  it("a dispute that allows nothing gets the pack but no proposals; accept-claim is refused", async () => {
    const state = { dispute: { dispute_id: "PP-D-DONE", status: "RESOLVED", dispute_life_cycle_stage: "CHARGEBACK", links: [] } as Dispute };
    const { post, get } = await start(state);
    const res = await post("/api/disputes/PP-D-DONE/evidence-pack", {});
    expect(res.body.data.proposals).toEqual({});
    expect(res.body.data.pack.reply_draft).toBeTruthy();
    const accept = await post("/api/disputes/PP-D-DONE/accept-claim", { note: "Refund" });
    expect(accept.status).toBe(409);
    expect(accept.body.error.code).toBe("action_not_allowed");
    expect((await get("/api/proposals")).body.data).toEqual([]);
    expect((await get("/api/disputes/PP-D-DONE")).body.data.allowed_actions.accept_claim.allowed).toBe(false);
  });

  it("re-checks right before execution: a dispute that moved on makes the proposal obsolete and sends nothing", async () => {
    const state = { dispute: { dispute_id: "PP-D-2", dispute_life_cycle_stage: "INQUIRY", links: [link("PP-D-2", "send-message"), link("PP-D-2", "accept-claim")] } as Dispute };
    const { post, pp } = await start(state);
    const pack = await post("/api/disputes/PP-D-2/evidence-pack", {});
    const message = pack.body.data.proposals.send_message;
    const accept = (await post("/api/disputes/PP-D-2/accept-claim", { note: "Refunding in full." })).body.data.proposal;
    expect(message.status).toBe("pending");

    state.dispute = { dispute_id: "PP-D-2", dispute_life_cycle_stage: "CHARGEBACK", links: [] };
    const run = await post(`/api/proposals/${message.id}/approve`);
    expect(run.body.data).toMatchObject({ status: "obsolete", error: { message: expect.stringMatching(/stage CHARGEBACK\. Nothing was sent/) } });
    expect((await post(`/api/proposals/${accept.id}/approve`)).body.data.status).toBe("obsolete");
    expect(pp.calls.filter((c) => c.method === "POST" && /\/(send-message|accept-claim)$/.test(c.url))).toHaveLength(0);
    // Obsolete proposals cannot run later either.
    expect((await post(`/api/proposals/${message.id}/approve`)).status).toBe(409);
  });

  it("chat dispute tools refuse actions PayPal does not allow", async () => {
    const state = { dispute: { dispute_id: "PP-D-3", dispute_life_cycle_stage: "CHARGEBACK", links: [] } as Dispute };
    const pp = sandboxWithDispute(state);
    const proposals = new ProposalStore(async () => undefined);
    const tools = agentTools({ paypal: pp.client, proposals, agentConfig: { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "http://localhost" }, paymentPath: "invoice", sessionId: "s", buyers: new DemoBuyers([]) });
    const send = tools.find((t) => t.name === "send_dispute_message")!;
    const accept = tools.find((t) => t.name === "accept_dispute_claim")!;
    expect(await send.execute({ dispute_id: "PP-D-3", message: "Hello" })).toMatchObject({ error: expect.stringMatching(/inquiry/) });
    expect(await accept.execute({ dispute_id: "PP-D-3", note: "Refund" })).toMatchObject({ error: expect.stringMatching(/accepting the claim/) });
    expect(proposals.list({ owner: "s" })).toEqual([]);
  });
});
