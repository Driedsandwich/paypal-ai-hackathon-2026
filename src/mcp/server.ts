#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BuyerSchema, JpItemSchema, ListingForSaleSchema, ShipmentFactsSchema } from "../agent/schemas.js";

/**
 * Okuri as an MCP server (stdio). It only calls Okuri's own JSON API over HTTP: the same
 * routes, validation, limits and approval gate the web UI uses. Writes to PayPal are
 * proposals; nothing is sent until a proposal is approved. The approve and reject tools are
 * offered by default (marked destructive, so the client asks the person before each call) and
 * can be removed with OKURI_MCP_ALLOW_APPROVE=0.
 */

export const DEFAULT_OKURI_URL = "https://okuri.onrender.com";
/** A sleeping free instance can take about a minute to wake up. */
export const REQUEST_TIMEOUT_MS = 120_000;
const SESSION_COOKIE = "okuri_sid";

export interface OkuriMcpOptions {
  /** Base URL of an Okuri instance, e.g. https://okuri.onrender.com. */
  baseUrl?: string;
  /** Value of the okuri_sid cookie to work in an existing session (e.g. the seller's browser). */
  session?: string;
  /** Expose okuri_approve_proposal and okuri_reject_proposal. Off by default. */
  allowApprove?: boolean;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

export const SERVER_INSTRUCTIONS = [
  "Okuri is an AI export desk for small Japanese sellers who sell abroad with PayPal: it turns a Japanese item into an English listing, prepares invoices and tracking, and helps answer buyer disputes.",
  "Every write to PayPal is a PROPOSAL. Tools named prepare/add/build only create proposals and send nothing to PayPal. A proposal runs only after it passes the approval gate, which works the same for a person in the web UI and for an AI agent.",
  "This is a sandbox demo: PayPal is the test environment (or an in-memory simulation), so no real money moves.",
  "Recommended flow: okuri_list_journeys to see the sales, okuri_prepare_invoice or okuri_add_tracking to create a proposal, okuri_list_proposals to show it to the seller, then let the seller approve it (in the web UI's Approvals page, or with okuri_approve_proposal when that tool is available and the seller has explicitly said to approve).",
  "Never approve a proposal on your own initiative.",
].join("\n");

interface ApiError {
  code: string;
  message: string;
  [key: string]: unknown;
}

type ApiResult = { ok: true; data: unknown } | { ok: false; status: number; error: ApiError };

const ID = z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/, "letters, digits, - and _ only");
const PROPOSAL_STATUSES = ["pending", "executing", "executed", "failed", "rejected", "unknown", "obsolete", "expired"] as const;

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Creates a proposal in the session; nothing reaches PayPal. */
const PROPOSE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const APPROVE_NOTE = "Sends the proposal's exact payload to PayPal (sandbox). Only call after the seller has reviewed the proposal and explicitly said to approve it.";
const GATE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function text(value: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

/** Drops keys whose value is undefined, so optional tool arguments are not sent as null. */
function defined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export function createOkuriMcpServer(options: OkuriMcpOptions = {}): McpServer {
  const base = (options.baseUrl ?? DEFAULT_OKURI_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;
  let cookie: string | undefined = options.session ? `${SESSION_COOKIE}=${options.session}` : undefined;
  let bootstrap: Promise<void> | undefined;

  /** Without OKURI_SESSION: take a fresh demo session from the site once, before the first call. */
  function ensureSession(): Promise<void> {
    if (cookie) return Promise.resolve();
    bootstrap ??= (async () => {
      const res = await doFetch(`${base}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
      await res.arrayBuffer().catch(() => undefined);
      const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      if (!set) throw new Error(`${base}/ did not hand out a demo session (no ${SESSION_COOKIE} cookie, HTTP ${res.status}); is OKURI_URL an Okuri server?`);
      cookie = set.split(";")[0]!;
    })().catch((err) => {
      bootstrap = undefined; // try again on the next call
      throw err;
    });
    return bootstrap;
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult> {
    await ensureSession();
    const headers: Record<string, string> = { Cookie: cookie!, Accept: "application/json" };
    if (method === "POST") headers["Content-Type"] = "application/json";
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, status: res.status, error: { code: "unexpected_response", message: `Okuri answered HTTP ${res.status} without JSON (it may still be waking up; try again in a minute).` } };
    }
    if (parsed && parsed.ok === true) return { ok: true, data: parsed.data };
    const error: ApiError = parsed?.error && typeof parsed.error.code === "string" ? parsed.error : { code: "unexpected_response", message: `Okuri answered HTTP ${res.status} in an unknown shape.` };
    return { ok: false, status: res.status, error };
  }

  /** Runs one API call and shapes the MCP result: data as JSON text, or an error result. */
  async function run(method: "GET" | "POST", path: string, body?: unknown): Promise<CallToolResult> {
    try {
      const r = await call(method, path, body);
      return r.ok ? text(r.data) : text({ error: r.error }, true);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      const message = timedOut ? `No answer from ${base} within ${Math.round(timeoutMs / 1000)} seconds.` : err instanceof Error ? err.message : String(err);
      return text({ error: { code: timedOut ? "timeout" : "request_failed", message } }, true);
    }
  }

  const server = new McpServer({ name: "okuri", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "okuri_health",
    { title: "Okuri status", description: "Okuri configuration status: AI model, PayPal connection (sandbox or in-memory simulation), demo buyers, limits and banner messages.", inputSchema: {}, annotations: { ...READ, title: "Okuri status" } },
    () => run("GET", "/api/health"),
  );

  server.registerTool(
    "okuri_list_journeys",
    {
      title: "List sales (journeys)",
      description: "List the seller's sales as journeys: each has its steps, the current stage, the next suggested action (often a pending proposal), the dispute branch, activity and counts. Start here.",
      inputSchema: {},
      annotations: { ...READ, title: "List sales (journeys)" },
    },
    () => run("GET", "/api/journeys"),
  );

  server.registerTool(
    "okuri_draft_listing",
    {
      title: "Draft an English listing",
      description: "Turn a Japanese item (title, description, price in JPY) into an English listing with a USD price. Starts a new draft journey and returns its sale_id. Uses the AI model (rate limited). Sends nothing to PayPal.",
      inputSchema: {
        item: JpItemSchema.describe("The item as the seller would type it, in Japanese"),
        country: z.string().regex(/^[A-Z]{2}$/).optional().describe("Destination country, ISO 3166-1 alpha-2 (default US)"),
      },
      annotations: { ...PROPOSE, title: "Draft an English listing" },
    },
    ({ item, country }) => run("POST", "/api/listings/draft", defined({ item, country })),
  );

  server.registerTool(
    "okuri_prepare_invoice",
    {
      title: "Prepare an invoice proposal",
      description:
        "Prepare a PayPal invoice (or payment link, depending on the server's payment path) for a demo buyer and a buyer note. Creates a PROPOSAL only; nothing is sent to PayPal until the seller approves it. The buyer is chosen by demo alias (see okuri_health), never by email. Pass sale_id to continue a draft from okuri_draft_listing.",
      inputSchema: {
        listing: ListingForSaleSchema.describe("What to bill: English title, description, price (and optional shipping in the same currency)"),
        buyer: BuyerSchema.describe('The demo buyer, e.g. { "alias": "Demo buyer 1" }'),
        sale_id: z.string().max(20).optional().describe("Continue this draft journey instead of starting a new one"),
        country: z.string().regex(/^[A-Z]{2}$/).optional().describe("Destination country, ISO 3166-1 alpha-2"),
        title_ja: z.string().max(200).optional().describe("The item's Japanese title, if known"),
      },
      annotations: { ...PROPOSE, title: "Prepare an invoice proposal" },
    },
    (args) => run("POST", "/api/invoices/prepare", defined(args)),
  );

  server.registerTool(
    "okuri_add_tracking",
    {
      title: "Prepare a tracking proposal",
      description:
        "Add a carrier and tracking number to a sale that was paid. Creates a PROPOSAL only; nothing is sent to PayPal until the seller approves it. Only for invoices and orders this Okuri created. Use kind \"invoice\" with invoice_id (or transaction_id), or kind \"order\" with order_id and capture_id.",
      inputSchema: {
        kind: z.enum(["invoice", "order"]).describe("What the payment was made through"),
        invoice_id: ID.optional().describe('kind "invoice": the PayPal invoice id'),
        transaction_id: ID.optional().describe('kind "invoice": the payment transaction id, if the invoice id is not given'),
        order_id: ID.optional().describe('kind "order": the PayPal order id'),
        capture_id: ID.optional().describe('kind "order": the capture id of the order'),
        carrier: z.string().trim().min(1).max(64).describe("Carrier name, e.g. Japan Post"),
        tracking_number: z.string().trim().min(1).max(64).describe("Tracking number"),
        notify_buyer: z.boolean().optional().describe("Let PayPal email the buyer (default true)"),
      },
      annotations: { ...PROPOSE, openWorldHint: true, title: "Prepare a tracking proposal" },
    },
    (args) => run("POST", "/api/tracking", defined(args)),
  );

  server.registerTool(
    "okuri_list_proposals",
    {
      title: "List proposals",
      description: "List the proposals in this session (what the AI or the seller prepared), with kind, summary, exact payload and status (pending, executed, rejected, ...). Show pending ones to the seller before anything is approved.",
      inputSchema: { status: z.enum(PROPOSAL_STATUSES).optional().describe("Only proposals with this status") },
      annotations: { ...READ, title: "List proposals" },
    },
    ({ status }) => run("GET", `/api/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  );

  server.registerTool(
    "okuri_list_disputes",
    {
      title: "List disputes",
      description: "List buyer disputes (cases) from PayPal and the ones Okuri knows about, with the linked sale and whether the seller can act on each.",
      inputSchema: {},
      annotations: { ...READ, openWorldHint: true, title: "List disputes" },
    },
    () => run("GET", "/api/disputes"),
  );

  server.registerTool(
    "okuri_build_evidence_pack",
    {
      title: "Build a dispute evidence pack",
      description:
        "Build an evidence pack and a reply draft for one dispute. Uses the AI model (rate limited). Creates PROPOSALS (provide evidence, send message) only for the actions PayPal currently allows; nothing is sent to PayPal until the seller approves them.",
      inputSchema: {
        dispute_id: ID.describe("PayPal dispute id, e.g. PP-D-1234"),
        invoice_id: ID.optional().describe("The invoice the dispute is about, if known"),
        tracking: ShipmentFactsSchema.optional().describe("Shipment facts: carrier, tracking_number, optional shipped_date and tracking_url"),
        seller_notes: z.string().max(2000).optional().describe("Facts from the seller to include"),
      },
      annotations: { ...PROPOSE, openWorldHint: true, title: "Build a dispute evidence pack" },
    },
    ({ dispute_id, ...rest }) => run("POST", `/api/disputes/${encodeURIComponent(dispute_id)}/evidence-pack`, defined(rest)),
  );

  if (options.allowApprove) {
    server.registerTool(
      "okuri_approve_proposal",
      {
        title: "Approve a proposal (sends to PayPal)",
        description: `Approve one pending proposal. ${APPROVE_NOTE} The stored payload runs as it is; nothing in this call can change it.`,
        inputSchema: { proposal_id: ID.describe("Id from okuri_list_proposals") },
        annotations: { ...GATE, title: "Approve a proposal (sends to PayPal)" },
      },
      ({ proposal_id }) => run("POST", `/api/proposals/${encodeURIComponent(proposal_id)}/approve`),
    );
    server.registerTool(
      "okuri_reject_proposal",
      {
        title: "Reject a proposal",
        description: "Reject one pending proposal so it can never run. Nothing is sent to PayPal. It is part of the same approval gate as okuri_approve_proposal (which sends the exact payload to PayPal, sandbox), so call it only when the seller has said to reject it.",
        inputSchema: { proposal_id: ID.describe("Id from okuri_list_proposals") },
        annotations: { ...GATE, title: "Reject a proposal" },
      },
      ({ proposal_id }) => run("POST", `/api/proposals/${encodeURIComponent(proposal_id)}/reject`),
    );
  }

  return server;
}

async function main(): Promise<void> {
  const session = process.env.OKURI_SESSION?.trim();
  const server = createOkuriMcpServer({
    baseUrl: process.env.OKURI_URL?.trim() || DEFAULT_OKURI_URL,
    ...(session ? { session } : {}),
    allowApprove: process.env.OKURI_MCP_ALLOW_APPROVE !== "0",
  });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; anything for a human goes to stderr.
  console.error(`okuri MCP server ready (${process.env.OKURI_URL?.trim() || DEFAULT_OKURI_URL}; approve tools ${process.env.OKURI_MCP_ALLOW_APPROVE !== "0" ? "ON" : "off"})`);
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
