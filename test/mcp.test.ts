import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { createOkuriMcpServer, type OkuriMcpOptions } from "../src/mcp/server.js";
import { startApp } from "./helpers/http.js";

// Okuri is started the way the offline demo runs (PAYPAL_OFFLINE_DEMO): every session gets a
// private seeded world, so no PayPal, AI key or network is involved. The MCP server talks to
// it over HTTP like it would to the hosted demo.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function okuri() {
  const app = await startApp({ settings: loadSettings({ PAYPAL_OFFLINE_DEMO: "true" }) });
  closers.push(app.close);
  return app;
}

/** An MCP client connected to a new Okuri MCP server in this process. */
async function connect(base: string, options: OkuriMcpOptions = {}) {
  const server = createOkuriMcpServer({ baseUrl: base, ...options });
  const client = new Client({ name: "okuri-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  closers.push(() => client.close());
  return client;
}

type Result = { isError?: boolean; content: Array<{ type: string; text?: string }> };
const data = (r: unknown) => JSON.parse((r as Result).content[0]!.text!);
async function tool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as Result;
}

const READ_ONLY = ["okuri_health", "okuri_list_journeys", "okuri_list_proposals", "okuri_list_disputes"];
const PROPOSE = ["okuri_draft_listing", "okuri_prepare_invoice", "okuri_add_tracking", "okuri_build_evidence_pack"];
const GATE = ["okuri_approve_proposal", "okuri_reject_proposal"];

describe("tool list", () => {
  it("offers 8 tools and no approve or reject by default", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_ONLY, ...PROPOSE].sort());
    for (const t of tools) expect(t.description, t.name).toBeTruthy();
    for (const name of READ_ONLY) expect(tools.find((t) => t.name === name)!.annotations).toMatchObject({ readOnlyHint: true });
    for (const name of PROPOSE) expect(tools.find((t) => t.name === name)!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(client.getInstructions()).toMatch(/PROPOSAL/);
    expect(client.getInstructions()).toMatch(/no real money/);
  });

  it("adds approve and reject as destructive, open-world tools when allowed", async () => {
    const app = await okuri();
    const client = await connect(app.base, { allowApprove: true });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    for (const name of GATE) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: true });
    }
    expect(tools.find((t) => t.name === "okuri_approve_proposal")!.description).toContain("Sends the proposal's exact payload to PayPal (sandbox). Only call after the seller has reviewed the proposal and explicitly said to approve it.");
  });

  it("rejects an approve call when the tool is not offered", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const r = (await client.callTool({ name: "okuri_approve_proposal", arguments: { proposal_id: "x" } }).catch((e) => e)) as Result | Error;
    // Either a protocol error or an error result; in both cases nothing was approved.
    if (r instanceof Error) expect(r.message).toMatch(/not found|Unknown tool/i);
    else expect(r.isError).toBe(true);
  });
});

describe("reading", () => {
  it("returns the six sample sales of the offline demo", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const journeys = data(await tool(client, "okuri_list_journeys"));
    expect(journeys.journeys).toHaveLength(6);
    expect(journeys.counts).toEqual({ draft: 2, invoiced: 1, paid: 1, shipped: 2, disputed: 1 });
    expect(data(await tool(client, "okuri_health")).paypal).toMatchObject({ configured: true, offline: true });
    expect(data(await tool(client, "okuri_list_disputes")).disputes.length).toBeGreaterThanOrEqual(1);
  });

  it("starts from one demo session and keeps it for every call", async () => {
    const app = await okuri();
    const seen: string[] = [];
    const client = await connect(app.base, {
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return fetch(url, init);
      }) as typeof fetch,
    });
    await Promise.all([tool(client, "okuri_list_journeys"), tool(client, "okuri_list_proposals")]);
    await tool(client, "okuri_health");
    expect(seen.filter((s) => s === "GET /")).toHaveLength(1);
    expect(seen[0]).toBe("GET /");
    expect(seen).toContain("GET /api/journeys");
  });

  it("works in the session given in OKURI_SESSION (the browser's)", async () => {
    const app = await okuri();
    await app.get("/api/journeys"); // the "browser" gets its session cookie
    const sid = app.cookie()!.split("=")[1]!;
    // The browser's proposals (the seeded world's) are visible through MCP; a fresh MCP session has its own.
    const mine = data(await tool(await connect(app.base, { session: sid }), "okuri_list_proposals"));
    const browser = (await app.get("/api/proposals")).body.data;
    expect(mine).toEqual(browser);
    expect(mine.length).toBeGreaterThanOrEqual(3); // the seeded world's pending proposals
    const other = data(await tool(await connect(app.base), "okuri_list_proposals"));
    expect(other.map((p: { id: string }) => p.id)).not.toEqual(mine.map((p: { id: string }) => p.id));
  });

  it("returns API errors as an error result with code and message", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const r = await tool(client, "okuri_prepare_invoice", { listing: { title: "Tea bowl", price: { currency_code: "USD", value: "80.00" } }, buyer: { alias: "Nobody" } });
    expect(r.isError).toBe(true);
    expect(data(r).error).toMatchObject({ code: "unknown_buyer" });
    expect(data(r).error.message).toMatch(/Demo buyer 1/);
  });

  it("answers with an error result when the server cannot be reached", async () => {
    const client = await connect("http://127.0.0.1:1", { timeoutMs: 3000 });
    const r = await tool(client, "okuri_health");
    expect(r.isError).toBe(true);
    expect(data(r).error.code).toBe("request_failed");
  });
});

describe("proposals and the approval gate", () => {
  it("prepare_invoice makes a proposal that list_proposals shows, and sends nothing", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const before = data(await tool(client, "okuri_list_proposals", { status: "pending" })).length;
    const made = data(
      await tool(client, "okuri_prepare_invoice", {
        listing: { title: "Handmade Japanese Tea Bowl", description: "Stoneware.", price: { currency_code: "USD", value: "80.00" } },
        buyer: { alias: "Demo buyer 1" },
        country: "US",
      }),
    );
    expect(made.proposal).toMatchObject({ status: "pending", kind: "create_and_send_invoice" });
    const pending = data(await tool(client, "okuri_list_proposals", { status: "pending" }));
    expect(pending).toHaveLength(before + 1);
    expect(pending.map((p: { id: string }) => p.id)).toContain(made.proposal.id);
    // Still a proposal: the sale it belongs to has not been invoiced.
    const sale = data(await tool(client, "okuri_list_journeys")).journeys.find((j: { id: string }) => j.id === made.sale_id);
    expect(sale).toMatchObject({ stage: "draft" });
  });

  it("add_tracking makes a tracking proposal for a paid sale", async () => {
    const app = await okuri();
    const client = await connect(app.base);
    const paid = data(await tool(client, "okuri_list_journeys")).journeys.find((j: { stage: string; invoice_id?: string }) => j.stage === "paid" && j.invoice_id);
    const made = data(await tool(client, "okuri_add_tracking", { kind: "invoice", invoice_id: paid.invoice_id, carrier: "Japan Post", tracking_number: "EJ123456789JP" }));
    expect(made.proposal).toMatchObject({ status: "pending", sale_id: paid.id });
    const listed = data(await tool(client, "okuri_list_proposals", { status: "pending" }));
    expect(listed.map((p: { id: string }) => p.id)).toContain(made.proposal.id);
  });

  it("approve runs the stored proposal and the sale moves on (only when allowed)", async () => {
    const app = await okuri();
    const client = await connect(app.base, { allowApprove: true });
    const journeys = data(await tool(client, "okuri_list_journeys")).journeys;
    const vase = journeys.find((j: { title_ja?: string }) => j.title_ja === "手作りの花器");
    expect(vase).toMatchObject({ stage: "draft" });
    const proposalId = vase.callout.proposal.id as string;

    const approved = data(await tool(client, "okuri_approve_proposal", { proposal_id: proposalId }));
    expect(approved.status).toBe("executed");
    const executed = data(await tool(client, "okuri_list_proposals", { status: "executed" }));
    expect(executed.map((p: { id: string }) => p.id)).toContain(proposalId);
    const after = data(await tool(client, "okuri_list_journeys")).journeys.find((j: { id: string }) => j.id === vase.id);
    expect(after).toMatchObject({ stage: "invoiced", current_step: 3 });

    // The same proposal cannot run twice.
    const again = await tool(client, "okuri_approve_proposal", { proposal_id: proposalId });
    expect(again.isError).toBe(true);
  });

  it("reject closes a proposal without running it (only when allowed)", async () => {
    const app = await okuri();
    const client = await connect(app.base, { allowApprove: true });
    const pending = data(await tool(client, "okuri_list_proposals", { status: "pending" }));
    const id = pending[0].id as string;
    expect(data(await tool(client, "okuri_reject_proposal", { proposal_id: id })).status).toBe("rejected");
    expect(data(await tool(client, "okuri_list_proposals", { status: "executed" }))).toHaveLength(0);
  });
});
