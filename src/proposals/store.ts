import { randomUUID } from "node:crypto";

/**
 * Every action that changes state at PayPal or reaches a buyer is a proposal.
 * The server stores the exact payload; the action runs only through approve(),
 * once, with the stored payload (never one supplied by the client at approve time).
 */
export const PROPOSAL_KINDS = [
  "create_and_send_invoice",
  "send_invoice_reminder",
  "create_payment_link",
  "capture_order",
  "add_order_tracking",
  "add_invoice_tracking",
  "provide_dispute_evidence",
  "send_dispute_message",
  "accept_dispute_claim",
  "seed_demo_data",
] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * - unknown: a PayPal write timed out; PayPal may or may not have done it. Needs checking,
 *   never retried automatically.
 * - obsolete: right before execution the action was no longer allowed (e.g. the dispute
 *   moved on); nothing was sent.
 * - expired: nobody approved it within 24 hours; it can no longer run.
 */
export type ProposalStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "unknown" | "obsolete" | "expired";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "executing", "executed", "failed", "rejected", "unknown", "obsolete", "expired"];

/** Store capacity and limits on unresolved work. */
export const PROPOSAL_STORE_MAX = 500;
export const PROPOSAL_PENDING_TTL_MS = 24 * 3_600_000;
export const PROPOSAL_MAX_PENDING_PER_ADDRESS = 50;

/** Thrown by the executor when the action is no longer allowed; the proposal becomes "obsolete". */
export class ProposalObsoleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalObsoleteError";
  }
}

/**
 * Thrown by the executor when a demo rule refuses the stored action (e.g. a recipient that is
 * not a demo buyer). The message is meant for the visitor.
 */
export class ProposalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalPolicyError";
  }
}

export interface Proposal<P = unknown> {
  id: string;
  /** Demo session that created the proposal. Only this session can see, approve or reject it. Never returned publicly. */
  owner: string;
  /** Rate-limit key of the creating client (for the pending cap). Never returned publicly. */
  address?: string;
  kind: ProposalKind;
  /** One line for the seller, e.g. "Send invoice for USD 80.00 to the buyer". */
  title: string;
  /** Exactly what will be sent to PayPal on approval (recipients by alias). Frozen. */
  payload: P;
  /**
   * AI-written text for the seller to copy into a DM to the buyer. Never sent to PayPal
   * (PayPal ignores custom reminder text and uses its own).
   */
  copyForDm?: string;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  result?: unknown;
  error?: unknown;
}

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_pending" | "store_full" | "too_many_pending",
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

export interface ExecutionContext {
  proposalId: string;
  /** Session that owns the proposal (e.g. created payment links are registered to it). */
  owner: string;
}

export type Executor = (kind: ProposalKind, payload: unknown, ctx: ExecutionContext) => Promise<unknown>;

export interface ProposeOptions {
  /** Session id of the visitor the proposal belongs to. */
  owner: string;
  /** Text for the seller to copy into a DM (not sent to PayPal). */
  copyForDm?: string;
  /** Rate-limit key of the creating client; at most 50 pending proposals per address. */
  address?: string;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();

  constructor(
    private readonly execute: Executor,
    private readonly options: {
      max?: number;
      now?: () => Date;
      newId?: () => string;
      /** Converts an execution error into something safe to show (e.g. PayPal debug_id). */
      describeError?: (err: unknown) => unknown;
      /** Errors for which the outcome at PayPal is unknown (e.g. a write that timed out). */
      isUnknownOutcome?: (err: unknown) => boolean;
      /** Pending proposals expire after this many ms (default 24 h). */
      pendingTtlMs?: number;
      maxPendingPerAddress?: number;
    } = {},
  ) {}

  private nowMs(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /** Marks pending proposals older than the TTL as expired (they can no longer run). */
  private expire(): void {
    const cutoff = this.nowMs() - (this.options.pendingTtlMs ?? PROPOSAL_PENDING_TTL_MS);
    for (const p of this.items.values()) {
      if (p.status === "pending" && Date.parse(p.createdAt) <= cutoff) {
        p.status = "expired";
        p.decidedAt = new Date(this.nowMs()).toISOString();
        p.error = { message: "Nobody approved this within 24 hours, so it expired. Nothing was sent." };
      }
    }
  }

  /**
   * Makes room for one more proposal by dropping the oldest finished ones. Pending and
   * executing proposals are never dropped: when the store is full of them, new proposals are
   * refused instead (F4).
   */
  private makeRoom(): void {
    const max = this.options.max ?? PROPOSAL_STORE_MAX;
    if (this.items.size < max) return;
    this.expire();
    // Finished ones first; "unknown" (needs checking) last.
    for (const pass of [(p: Proposal) => p.status !== "pending" && p.status !== "executing" && p.status !== "unknown", (p: Proposal) => p.status === "unknown"]) {
      for (const [id, p] of this.items) {
        if (this.items.size < max) return;
        if (pass(p)) this.items.delete(id);
      }
    }
    if (this.items.size >= max) {
      throw new ProposalError("The demo's approval queue is full of proposals waiting for a decision. Approve or reject some, or try again later.", "store_full");
    }
  }

  /** Throws ProposalError (store_full / too_many_pending) when this proposal cannot be added. */
  assertRoom(count = 1, address?: string): void {
    this.expire();
    if (address) {
      const max = this.options.maxPendingPerAddress ?? PROPOSAL_MAX_PENDING_PER_ADDRESS;
      let pending = 0;
      for (const p of this.items.values()) if (p.address === address && p.status === "pending") pending += 1;
      if (pending + count > max) {
        throw new ProposalError(`Too many proposals from your address are waiting for a decision (limit ${max}). Approve or reject some first.`, "too_many_pending");
      }
    }
    const max = this.options.max ?? PROPOSAL_STORE_MAX;
    let unresolved = 0;
    for (const p of this.items.values()) if (p.status === "pending" || p.status === "executing") unresolved += 1;
    if (unresolved + count > max) {
      throw new ProposalError("The demo's approval queue is full of proposals waiting for a decision. Approve or reject some, or try again later.", "store_full");
    }
  }

  propose<P>(kind: ProposalKind, title: string, payload: P, opts: ProposeOptions): Proposal<P> {
    if (!opts.owner) throw new Error("a proposal needs an owner session");
    this.assertRoom(1, opts.address);
    this.makeRoom();
    const now = this.options.now?.() ?? new Date();
    const proposal: Proposal<P> = {
      id: this.options.newId?.() ?? `prop_${randomUUID()}`,
      owner: opts.owner,
      ...(opts.address ? { address: opts.address } : {}),
      kind,
      title,
      payload: deepFreeze(structuredClone(payload)),
      ...(opts.copyForDm ? { copyForDm: opts.copyForDm } : {}),
      status: "pending",
      createdAt: now.toISOString(),
    };
    this.items.set(proposal.id, proposal as Proposal);
    return proposal;
  }

  /** The proposal if it exists and belongs to `owner` (other sessions' proposals look absent). */
  get(id: string, owner: string): Proposal | undefined {
    this.expire();
    const p = this.items.get(id);
    return p && p.owner === owner ? p : undefined;
  }

  /** Any proposal by id, regardless of owner. Server-internal use only (e.g. capture de-duplication). */
  peek(id: string): Proposal | undefined {
    return this.items.get(id);
  }

  /** The owner's proposals, newest first. */
  list(filter: { owner: string; status?: ProposalStatus }): Proposal[] {
    this.expire();
    return [...this.items.values()].reverse().filter((p) => p.owner === filter.owner && (!filter.status || p.status === filter.status));
  }

  reject(id: string, owner: string): Proposal {
    const p = this.pending(id, owner);
    p.status = "rejected";
    p.decidedAt = (this.options.now?.() ?? new Date()).toISOString();
    return p;
  }

  /**
   * Runs the stored payload once. The status flips to "executing" before the first
   * await, so a second concurrent approve of the same id is refused.
   */
  async approve(id: string, owner: string): Promise<Proposal> {
    const p = this.pending(id, owner);
    p.status = "executing";
    p.decidedAt = (this.options.now?.() ?? new Date()).toISOString();
    try {
      p.result = await this.execute(p.kind, p.payload, { proposalId: p.id, owner: p.owner });
      p.status = "executed";
    } catch (err) {
      p.status = err instanceof ProposalObsoleteError ? "obsolete" : this.options.isUnknownOutcome?.(err) ? "unknown" : "failed";
      p.error = this.options.describeError ? this.options.describeError(err) : { message: err instanceof Error ? err.message : String(err) };
    }
    return p;
  }

  private pending(id: string, owner: string): Proposal {
    this.expire();
    const p = this.get(id, owner);
    if (!p) throw new ProposalError(`proposal ${id} not found`, "not_found");
    if (p.status !== "pending") throw new ProposalError(`proposal ${id} is ${p.status}, not pending`, "not_pending");
    return p;
  }
}
