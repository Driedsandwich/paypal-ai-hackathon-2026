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
 */
export type ProposalStatus = "pending" | "executing" | "executed" | "failed" | "rejected" | "unknown" | "obsolete";

export const PROPOSAL_STATUSES: readonly ProposalStatus[] = ["pending", "executing", "executed", "failed", "rejected", "unknown", "obsolete"];

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
  kind: ProposalKind;
  /** One line for the seller, e.g. "Send invoice for USD 80.00 to the buyer". */
  title: string;
  /** Exactly what will be sent to PayPal on approval. Frozen. */
  payload: P;
  status: ProposalStatus;
  createdAt: string;
  decidedAt?: string;
  result?: unknown;
  error?: unknown;
}

export class ProposalError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "not_pending",
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

export type Executor = (kind: ProposalKind, payload: unknown) => Promise<unknown>;

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
    } = {},
  ) {}

  propose<P>(kind: ProposalKind, title: string, payload: P): Proposal<P> {
    const now = this.options.now?.() ?? new Date();
    const proposal: Proposal<P> = {
      id: this.options.newId?.() ?? `prop_${randomUUID()}`,
      kind,
      title,
      payload: deepFreeze(structuredClone(payload)),
      status: "pending",
      createdAt: now.toISOString(),
    };
    this.items.set(proposal.id, proposal as Proposal);
    this.evict();
    return proposal;
  }

  get(id: string): Proposal | undefined {
    return this.items.get(id);
  }

  /** Newest first. */
  list(filter?: { status?: ProposalStatus }): Proposal[] {
    return [...this.items.values()].reverse().filter((p) => !filter?.status || p.status === filter.status);
  }

  reject(id: string): Proposal {
    const p = this.pending(id);
    p.status = "rejected";
    p.decidedAt = (this.options.now?.() ?? new Date()).toISOString();
    return p;
  }

  /**
   * Runs the stored payload once. The status flips to "executing" before the first
   * await, so a second concurrent approve of the same id is refused.
   */
  async approve(id: string): Promise<Proposal> {
    const p = this.pending(id);
    p.status = "executing";
    p.decidedAt = (this.options.now?.() ?? new Date()).toISOString();
    try {
      p.result = await this.execute(p.kind, p.payload);
      p.status = "executed";
    } catch (err) {
      p.status = err instanceof ProposalObsoleteError ? "obsolete" : this.options.isUnknownOutcome?.(err) ? "unknown" : "failed";
      p.error = this.options.describeError ? this.options.describeError(err) : { message: err instanceof Error ? err.message : String(err) };
    }
    return p;
  }

  private pending(id: string): Proposal {
    const p = this.items.get(id);
    if (!p) throw new ProposalError(`proposal ${id} not found`, "not_found");
    if (p.status !== "pending") throw new ProposalError(`proposal ${id} is ${p.status}, not pending`, "not_pending");
    return p;
  }

  private evict(): void {
    const max = this.options.max ?? 500;
    if (this.items.size <= max) return;
    for (const [id, p] of this.items) {
      if (this.items.size <= max) break;
      if (p.status !== "pending" && p.status !== "executing") this.items.delete(id);
    }
    for (const [id, p] of this.items) {
      if (this.items.size <= max) break;
      if (p.status !== "executing") this.items.delete(id);
    }
  }
}
