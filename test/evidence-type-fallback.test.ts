import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { otherEvidenceFallback } from "../src/agent/tasks.js";
import { loadSettings } from "../src/config.js";
import type { Dispute } from "../src/paypal/types.js";
import type { ProvideEvidencePayload } from "../src/proposals/actions.js";
import { FAKE_CONFIG, type RecordedCall } from "./helpers/fake-fetch.js";
import { startApp } from "./helpers/http.js";
import { paypalWith, SANDBOX } from "./helpers/paypal.js";

// Pass 5, item 1: on a real sandbox CHARGEBACK case PayPal refused PROOF_OF_FULFILLMENT with
// EVIDENCE_TYPE_IS_NOT_ALLOWED and accepted the same shipment details as OTHER.
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/sandbox-evidence-type-refused-20261101.json", import.meta.url), "utf8")) as { dispute: Dispute; error: Record<string, unknown> };
const ID = FIXTURE.dispute.dispute_id;

/** The evidence types in a recorded provide-evidence call (multipart part "input"). */
function evidencesOf(c: RecordedCall): Array<{ evidence_type: string; notes?: string; evidence_info?: unknown }> {
  return JSON.parse(c.form!.find((f) => f.name === "input")!.value).evidences;
}

/** A sandbox that refuses everything but OTHER, and moves the case to UNDER_REVIEW once OTHER is accepted. */
function sandbox(status: number, refuseOther = false) {
  const state = { dispute: structuredClone(FIXTURE.dispute) };
  const pp = paypalWith((c) => {
    const u = c.url.replace(SANDBOX, "");
    if (u === `/v1/customer/disputes/${ID}` && c.method === "GET") return { json: state.dispute };
    if (u === `/v1/customer/disputes/${ID}/provide-evidence`) {
      const types = evidencesOf(c).map((e) => e.evidence_type);
      if (types.some((t) => t !== "OTHER") || refuseOther) return { status, json: FIXTURE.error };
      state.dispute = { ...state.dispute, status: "UNDER_REVIEW", links: [state.dispute.links![0]!] };
      return { json: { links: [] } };
    }
    return undefined;
  });
  return { pp, state };
}

describe("otherEvidenceFallback", () => {
  const payload: ProvideEvidencePayload = {
    disputeId: ID,
    evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "JPN_JAPAN_POST", tracking_number: "EJ123456789JP" }] }, notes: "The tea bowl was shipped on 2026-10-17." }],
    attachments: [{ name: "invoice-0001.pdf", contentType: "application/pdf", base64: "JVBERi0=" }],
  };

  it("moves the shipment details into the notes of an OTHER evidence and keeps the attachments", () => {
    expect(otherEvidenceFallback(payload)).toEqual({
      disputeId: ID,
      evidences: [{ evidence_type: "OTHER", notes: "The tea bowl was shipped on 2026-10-17.\n\nShipment: carrier Japan Post, tracking number EJ123456789JP." }],
      attachments: payload.attachments,
    });
  });

  it("names a free-text carrier, keeps the shipment line whole within 2000 characters, and never loops", () => {
    const long = { ...payload, evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "OTHER", carrier_name_other: "Seino", tracking_number: "1234", tracking_url: "https://example.com/t/1234" }] }, notes: "x".repeat(2000) }] };
    const notes = otherEvidenceFallback(long)!.evidences[0]!.notes!;
    expect(notes.length).toBeLessThanOrEqual(2000);
    expect(notes.endsWith("Shipment: carrier Seino, tracking number 1234, tracking page https://example.com/t/1234.")).toBe(true);
    expect(otherEvidenceFallback({ ...payload, evidences: [{ evidence_type: "OTHER", notes: "n" }] })).toBeUndefined();
  });
});

describe("EVIDENCE_TYPE_IS_NOT_ALLOWED over HTTP", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  for (const status of [400, 422]) {
    it(`HTTP ${status}: the proposal stays failed with PayPal's debug_id, and a new OTHER proposal waits for approval`, async () => {
      const { pp } = sandbox(status);
      const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({}) });
      close = app.close;
      const pack = await app.post(`/api/disputes/${ID}/evidence-pack`, { tracking: { carrier: "Japan Post", tracking_number: "EJ123456789JP" } });
      const first = pack.body.data.proposals.provide_evidence;
      expect(first.payload.evidences[0].evidence_type).toBe("PROOF_OF_FULFILLMENT");

      const run = (await app.post(`/api/proposals/${first.id}/approve`)).body.data;
      expect(run.status).toBe("failed");
      expect(run.error).toMatchObject({
        message: expect.stringMatching(/did not accept evidence type PROOF_OF_FULFILLMENT .*EVIDENCE_TYPE_IS_NOT_ALLOWED.*Nothing was submitted.*evidence type OTHER/),
        paypal: { status, debugId: "f0e1d2c3b4a59", issues: [expect.stringMatching(/^EVIDENCE_TYPE_IS_NOT_ALLOWED/)] },
        refused_evidence_type: "PROOF_OF_FULFILLMENT",
      });
      const next = run.follow_up_proposal;
      expect(run.error.follow_up_proposal_id).toBe(next.id);
      expect(next).toMatchObject({ kind: "provide_dispute_evidence", status: "pending" });
      expect(next.payload.evidences).toEqual([{ evidence_type: "OTHER", notes: expect.stringContaining("Shipment: carrier Japan Post, tracking number EJ123456789JP.") }]);
      expect(next.payload.evidences[0].evidence_info).toBeUndefined();
      // Nothing more was sent: the new proposal needs its own approval.
      const writes = () => pp.apiCalls().filter((c) => c.url.endsWith("/provide-evidence"));
      expect(writes()).toHaveLength(1);
      expect((await app.get("/api/proposals?status=pending")).body.data.map((p: { id: string }) => p.id)).toEqual([next.id]);

      const second = (await app.post(`/api/proposals/${next.id}/approve`)).body.data;
      expect(second.status).toBe("executed");
      expect(writes()).toHaveLength(2);
      expect(evidencesOf(writes()[1]!).map((e) => e.evidence_type)).toEqual(["OTHER"]);
    });
  }

  it("after an executed dispute action the case is read again from PayPal and shown with its new status at once", async () => {
    const { pp } = sandbox(422);
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({}) });
    close = app.close;
    const opened = (await app.post("/api/disputes/open", { dispute_id: ID })).body.data;
    expect(opened.allowed_actions.provide_evidence.allowed).toBe(true);
    // The list (served from the 30 s cache) shows the case as waiting for the seller.
    expect((await app.get("/api/disputes")).body.data.disputes.find((d: { dispute_id: string }) => d.dispute_id === ID).status).toBe("WAITING_FOR_SELLER_RESPONSE");

    const first = (await app.post(`/api/disputes/${ID}/evidence-pack`, {})).body.data.proposals.provide_evidence;
    const run = (await app.post(`/api/proposals/${first.id}/approve`)).body.data;
    expect(run.status).toBe("executed");
    // Read straight after the write (a GET after the provide-evidence POST).
    const calls = pp.apiCalls().map((c) => `${c.method} ${c.url.replace(SANDBOX, "")}`);
    expect(calls.slice(calls.lastIndexOf(`POST /v1/customer/disputes/${ID}/provide-evidence`) + 1)).toEqual([`GET /v1/customer/disputes/${ID}`]);
    expect(run.dispute).toMatchObject({ dispute_id: ID, status: "UNDER_REVIEW", seller_action_available: false, notice: expect.any(String) });
    expect(run.dispute.allowed_actions.provide_evidence.allowed).toBe(false);

    expect((await app.post("/api/disputes/open", { dispute_id: ID })).body.data).toMatchObject({ status: "UNDER_REVIEW", seller_action_available: false });
    expect((await app.get(`/api/disputes/${ID}`)).body.data.status).toBe("UNDER_REVIEW");
    expect((await app.get("/api/disputes")).body.data.disputes.find((d: { dispute_id: string }) => d.dispute_id === ID).status).toBe("UNDER_REVIEW");
  });

  it("an OTHER submission that is refused gets no further proposal", async () => {
    const { pp } = sandbox(422, true);
    const app = await startApp({ paypalConfig: FAKE_CONFIG, paypal: pp.client, settings: loadSettings({}) });
    close = app.close;
    const pack = await app.post(`/api/disputes/${ID}/evidence-pack`, {});
    const first = pack.body.data.proposals.provide_evidence;
    expect(first.payload.evidences[0].evidence_type).toBe("OTHER");
    const run = (await app.post(`/api/proposals/${first.id}/approve`)).body.data;
    expect(run.status).toBe("failed");
    expect(run.error.message).toBe("PayPal could not complete the request");
    expect(run.follow_up_proposal).toBeUndefined();
  });
});
