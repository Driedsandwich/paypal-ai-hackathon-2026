import { useState, type ReactNode } from "react";
import { SEAL_GLYPH } from "./seal-glyph";
import { addMoney, api, ApiError, itemPlusShipping, money, providerLabel, type Journey, type Money, type Proposal } from "./api";

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    const b = error.body;
    return (
      <div className="error" role="alert">
        <Icon name="alert" />
        <div>
          <strong>{b.message}</strong>
          {b.issues && <ul>{b.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          {b.paypal && (
            <p>
              PayPal: {b.paypal.name ?? b.paypal.status} {b.paypal.issues?.join("; ")}
              {b.paypal.debugId && <> · debug_id <code>{b.paypal.debugId}</code></>}
            </p>
          )}
          {b.retryAfterSeconds !== undefined && <p>Try again in about {Math.ceil(b.retryAfterSeconds / 60)} minute(s).</p>}
        </div>
      </div>
    );
  }
  return (
    <div className="error" role="alert">
      <Icon name="alert" />
      <div>{error instanceof Error ? error.message : String(error)}</div>
    </div>
  );
}

/** Runs an async action with busy/error state. */
export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (...args: A): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, error, clear: () => setError(null) };
}

// ---------- Icons: thin line icons (A1 style), decorative ----------

const PATHS: Record<string, ReactNode> = {
  draft: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  invoice: <><path d="M6 3h12v18H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  paid: <><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M3 10h18M7 14h3" /></>,
  shipped: <><path d="M12 3l8 4v10l-8 4-8-4V7z" /><path d="M4 7l8 4 8-4M12 11v10" /></>,
  disputed: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16v.5" /></>,
  mail: <><rect x="3" y="6" width="18" height="12" rx="1" /><path d="M3 7l9 6 9-6" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></>,
  truck: <><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" /><circle cx="7" cy="17" r="1.6" /><circle cx="17" cy="17" r="1.6" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  link: <><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1" /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1" /></>,
  card: <><rect x="3" y="6" width="18" height="12" rx="1.5" /><path d="M3 10h18" /></>,
  message: <><path d="M4 5h16v11H9l-5 4z" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
};

export function Icon({ name, size = 20, title }: { name: string; size?: number; title?: string }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      {PATHS[name] ?? PATHS.doc}
    </svg>
  );
}

/**
 * Decorative seal (A1 "Paper & seal"): a vermilion square stamp with a white 送 ("send", as in
 * Okuri), slightly tilted with a light stamped texture. Not interactive, hidden from assistive tech.
 */
export function Seal({ size = 22 }: { size?: number }) {
  return (
    <svg className="seal" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <defs>
        <filter id="okuri-seal-stamp" x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves={2} seed={4} result="wobble" />
          <feDisplacementMap in="SourceGraphic" in2="wobble" scale={2.6} xChannelSelector="R" yChannelSelector="G" result="edge" />
          <feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves={3} seed={9} result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -18 13.2" result="ink" />
          <feComposite in="edge" in2="ink" operator="in" />
        </filter>
      </defs>
      <g filter="url(#okuri-seal-stamp)" transform="rotate(-4 50 50)">
        <rect x="2" y="2" width="96" height="96" rx="8" style={{ fill: "var(--accent)" }} />
        <path d={SEAL_GLYPH.d} transform={`translate(50 50) scale(${70 / SEAL_GLYPH.height})`} style={{ fill: "var(--paper)" }} />
      </g>
    </svg>
  );
}

// ---------- Proposals ----------

export const KIND_LABEL: Record<string, string> = {
  create_and_send_invoice: "Send invoice",
  send_invoice_reminder: "Send reminder",
  create_payment_link: "Create payment link",
  capture_order: "Capture payment",
  add_invoice_tracking: "Register tracking",
  add_order_tracking: "Register tracking",
  provide_dispute_evidence: "Submit dispute evidence",
  send_dispute_message: "Send dispute reply",
  accept_dispute_claim: "Accept claim and refund",
  seed_demo_data: "Seed demo data",
};

export const KIND_ICON: Record<string, string> = {
  create_and_send_invoice: "invoice",
  send_invoice_reminder: "mail",
  create_payment_link: "link",
  capture_order: "card",
  add_invoice_tracking: "truck",
  add_order_tracking: "truck",
  provide_dispute_evidence: "shield",
  send_dispute_message: "message",
  accept_dispute_claim: "shield",
  seed_demo_data: "doc",
};

const STATUS: Record<Proposal["status"], { label: string; tone: string; icon: string }> = {
  pending: { label: "Needs approval", tone: "accent", icon: "alert" },
  executing: { label: "Running…", tone: "muted", icon: "doc" },
  executed: { label: "Done", tone: "ok", icon: "check" },
  failed: { label: "Failed", tone: "err", icon: "alert" },
  rejected: { label: "Rejected", tone: "muted", icon: "close" },
  unknown: { label: "Unknown: needs checking", tone: "err", icon: "alert" },
  obsolete: { label: "Obsolete: nothing sent", tone: "warn", icon: "alert" },
  expired: { label: "Expired", tone: "muted", icon: "close" },
};

export function StatusTag({ status }: { status: Proposal["status"] }) {
  const s = STATUS[status];
  return (
    <span className={`tag tag-${s.tone}`}>
      <Icon name={s.icon} size={14} /> {s.label}
    </span>
  );
}

type AnyPayload = Record<string, any>;

/** One sentence: what approving does. */
export function consequence(p: Proposal, j?: Journey): string {
  const pl = p.payload as AnyPayload;
  switch (p.kind) {
    case "create_and_send_invoice":
      return `Sends a PayPal invoice to ${pl.recipient_alias ?? j?.buyer ?? "the buyer"}.`;
    case "create_payment_link":
      return `Creates a PayPal payment link for ${pl.recipient_alias ?? "the buyer"}.`;
    case "send_invoice_reminder":
      return "PayPal sends its standard reminder email to the buyer.";
    case "capture_order":
      return "Captures the buyer's approved payment at PayPal.";
    case "add_invoice_tracking":
    case "add_order_tracking":
      return "Registers the tracking number with PayPal and notifies the buyer.";
    case "provide_dispute_evidence":
      return "Sends the evidence and notes to PayPal for this dispute.";
    case "send_dispute_message":
      return "Sends the reply to the buyer through PayPal's dispute messages.";
    case "accept_dispute_claim":
      return "Accepts the claim: PayPal refunds the buyer.";
    case "seed_demo_data":
      return "Creates the sample invoices or payment links in the PayPal sandbox.";
    default:
      return "Runs this action at PayPal.";
  }
}

function sumItems(items: Array<{ quantity: string; unit_amount: Money }> | undefined): Money | undefined {
  if (!items?.length) return undefined;
  const c = items[0]!.unit_amount.currency_code;
  const total = items.reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity || 1), 0);
  return { currency_code: c, value: total.toFixed(["JPY", "HUF", "TWD"].includes(c) ? 0 : 2) };
}

/** What the proposal will send, in human terms (ledger rows). */
export function ProposalSummary({ proposal, compact = false }: { proposal: Proposal; compact?: boolean }) {
  const pl = proposal.payload as AnyPayload;
  switch (proposal.kind) {
    case "create_and_send_invoice": {
      const items = pl.invoice?.items as Array<{ name: string; quantity: string; unit_amount: Money }> | undefined;
      const itemTotal = sumItems(items);
      const shipping = pl.invoice?.amount?.breakdown?.shipping?.amount as Money | undefined;
      const total = addMoney(itemTotal, shipping);
      return (
        <div className="ledger">
          {!compact && <div className="ledger-cap">Invoice draft</div>}
          {items?.map((i, n) => (
            <div className="ledger-row" key={n}>
              <span className="clamp1">{i.name}{Number(i.quantity) > 1 ? ` × ${i.quantity}` : ""}</span>
              <span className="num">{money(i.unit_amount)}</span>
            </div>
          ))}
          {shipping && (
            <div className="ledger-row">
              <span>Shipping</span>
              <span className="num">{money(shipping)}</span>
            </div>
          )}
          <div className="ledger-row total">
            <span>Total</span>
            <span className="num serif">{money(total)}</span>
          </div>
          {shipping && <p className="muted small">{itemPlusShipping(itemTotal, shipping)}</p>}
          {!compact && pl.invoice?.detail?.note && <p className="note-text"><span className="muted">Note to the buyer:</span> {pl.invoice.detail.note}</p>}
        </div>
      );
    }
    case "create_payment_link": {
      const unit = pl.order?.purchase_units?.[0];
      const shipping = unit?.amount?.breakdown?.shipping as Money | undefined;
      const itemTotal = (unit?.amount?.breakdown?.item_total as Money | undefined) ?? unit?.amount;
      return (
        <div className="ledger">
          <div className="ledger-row"><span className="clamp1">{unit?.description}</span><span className="num">{money(itemTotal)}</span></div>
          {shipping && <div className="ledger-row"><span>Shipping</span><span className="num">{money(shipping)}</span></div>}
          <div className="ledger-row total"><span>Total</span><span className="num serif">{money(unit?.amount)}</span></div>
          {shipping && <p className="muted small">{itemPlusShipping(itemTotal, shipping)}</p>}
        </div>
      );
    }
    case "send_invoice_reminder":
      return (
        <div className="ledger">
          <div className="ledger-row"><span>Invoice</span><span className="num">{pl.invoiceId}</span></div>
          <div className="ledger-row"><span>Text</span><span>PayPal's standard reminder</span></div>
        </div>
      );
    case "add_invoice_tracking":
    case "add_order_tracking": {
      const t = proposal.kind === "add_invoice_tracking" ? pl.trackers?.[0] : pl.tracker;
      return (
        <div className="ledger">
          <div className="ledger-row"><span>Carrier</span><span>{t?.carrier === "OTHER" ? t?.carrier_name_other : t?.carrier}</span></div>
          <div className="ledger-row"><span>Tracking number</span><span className="num">{t?.tracking_number}</span></div>
          <div className="ledger-row"><span>Notify buyer</span><span>{(t?.notify_buyer ?? t?.notify_payer) ? "Yes" : "No"}</span></div>
        </div>
      );
    }
    case "provide_dispute_evidence":
      return (
        <div className="ledger">
          <div className="ledger-row"><span>Evidence</span><span>{(pl.evidences ?? []).map((e: AnyPayload) => e.evidence_type).join(", ")}</span></div>
          <div className="ledger-row"><span>Files</span><span>{(pl.attachments ?? []).map((a: AnyPayload) => a.name).join(", ") || "none"}</span></div>
          {!compact && <p className="note-text">{pl.evidences?.[0]?.notes}</p>}
        </div>
      );
    case "send_dispute_message":
      return <div className="ledger">{compact ? <p className="clamp2">{pl.message}</p> : <p className="note-text pre">{pl.message}</p>}</div>;
    case "accept_dispute_claim":
      return <div className="ledger"><p className="note-text">{pl.note}</p></div>;
    case "seed_demo_data":
      return <div className="ledger"><div className="ledger-row"><span>Samples</span><span>{(pl.invoices ?? pl.orders ?? []).length}</span></div></div>;
    default:
      return null;
  }
}

/** The exact JSON sent to PayPal on approval. */
export function PayloadDetails({ proposal }: { proposal: Proposal }) {
  return (
    <details className="payload">
      <summary>Exact payload sent to PayPal on approval ({proposal.kind}; buyers shown by demo alias)</summary>
      <pre>{JSON.stringify(proposal.payload, (k, v) => (k === "bytes" ? `${v} bytes` : v), 2)}</pre>
    </details>
  );
}

/** AI text the seller sends to the buyer by DM (these sellers talk to buyers in social media DMs). */
export function CopyForDm({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="dm">
      <div className="dm-head">
        <span className="muted">Copy for DM (not sent by PayPal)</span>
        <button className="btn btn-ghost btn-small" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="pre">{text}</p>
    </div>
  );
}

/** Approve (vermilion) and Reject (ink outline). The server enforces the gate. */
export function DecisionButtons({ proposal, onDone, approveLabel = "Approve", secondary }: { proposal: Proposal; onDone: (p: Proposal) => void; approveLabel?: string; secondary?: ReactNode }) {
  const act = useAction(async (verb: "approve" | "reject") => {
    const next = await api.post<Proposal>(`/api/proposals/${proposal.id}/${verb}`);
    onDone(next);
  });
  if (proposal.status !== "pending") return <StatusTag status={proposal.status} />;
  return (
    <>
      <div className="decision">
        {secondary}
        <button className="btn btn-outline" disabled={act.busy} onClick={() => void act.run("reject")}>Reject</button>
        <button className="btn btn-primary" disabled={act.busy} onClick={() => void act.run("approve")}>{act.busy ? "Working…" : approveLabel}</button>
      </div>
      <ErrorBox error={act.error} />
    </>
  );
}

/** Outcome of a proposal that is no longer pending. */
export function ProposalOutcome({ proposal }: { proposal: Proposal }) {
  if (proposal.status === "pending" || proposal.status === "executed" || proposal.status === "rejected") return null;
  return (
    <div className={proposal.status === "obsolete" || proposal.status === "expired" ? "warning" : "error"} role="status">
      <Icon name="alert" />
      <div>
        {proposal.error?.message}
        {proposal.error?.paypal?.debugId && <> · debug_id <code>{proposal.error.paypal.debugId}</code></>}
        {proposal.error?.paypal?.issues && <> · {proposal.error.paypal.issues.join("; ")}</>}
      </div>
    </div>
  );
}

export function ModelChip({ by }: { by?: { provider: string; model?: string | null; fallback_from?: { provider: string; reason: string } } }) {
  if (!by) return null;
  const title = `${by.model ?? by.provider}${by.fallback_from ? ` (answered because ${providerLabel(by.fallback_from.provider)} could not: ${by.fallback_from.reason.replace(/_/g, " ")})` : ""}`;
  return (
    <span className="chip chip-small" title={title}>
      {providerLabel(by.provider)}
      {by.fallback_from && <span className="chip-sub"> · fallback</span>}
    </span>
  );
}
