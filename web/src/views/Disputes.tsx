import { useEffect, useMemo, useState } from "react";
import { api, money, type Journey, type Money, type Proposal } from "../api";
import type { ViewProps } from "../App";
import { CopyForDm, DecisionButtons, ErrorBox, Icon, ModelChip, PayloadDetails, ProposalOutcome, useAction } from "../components";

interface DisputeRow {
  dispute_id: string;
  reason?: string;
  status?: string;
  stage?: string;
  amount?: Money;
  create_time?: string;
  seller_response_due_date?: string;
}
interface DisputeDetail extends DisputeRow {
  allowed_actions: Record<"send_message" | "provide_evidence" | "accept_claim", { allowed: boolean; reason: string }>;
  messages: Array<{ posted_by?: string; time_posted?: string; content: string }>;
}
interface Pack {
  summary: string;
  timeline: Array<{ date: string; event: string; source: string }>;
  reply_draft: string;
  evidence_notes: string;
  recommended_action: string;
  missing_information: string[];
  unverified_facts: string[];
  attachments: Array<{ name: string; description: string }>;
  generated_by: { provider: string; model?: string };
}
interface PackResult {
  pack: Pack;
  proposals: { provide_evidence?: Proposal; send_message?: Proposal };
  allowed_actions: DisputeDetail["allowed_actions"];
}

const human = (s?: string) => (s ?? "").replace(/_/g, " ").toLowerCase();

export function DisputesView({ health, data, refresh, route }: ViewProps) {
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  const load = useAction(async () => setRows((await api.get<{ disputes: DisputeRow[] }>("/api/disputes")).disputes));
  useEffect(() => {
    if (health.paypal.configured) void load.run();
  }, [health.paypal.configured]);
  const saleOf = useMemo(() => new Map((data?.journeys ?? []).filter((j) => j.dispute).map((j) => [j.dispute!.dispute_id, j])), [data]);
  const selectedId = route.arg ?? rows?.[0]?.dispute_id;

  if (!health.paypal.configured) {
    return (
      <div className="form-page">
        <header className="page-head"><h1 className="serif">Disputes</h1></header>
        <p className="empty-note">PayPal is not configured on this server, so there are no disputes to show. Set the sandbox credentials, or run the offline demo (PAYPAL_OFFLINE_DEMO=true).</p>
      </div>
    );
  }
  return (
    <div className="inbox disputes">
      <section className="inbox-list" aria-label="Disputes">
        <div className="inbox-head">
          <h1 className="h2 serif">Disputes <span className="muted count-inline">{rows?.length ?? ""}</span></h1>
          <button className="btn btn-ghost btn-small" disabled={load.busy} onClick={() => void load.run()}>Refresh</button>
        </div>
        <ErrorBox error={load.error} />
        {!rows && !load.error && <p className="loading" aria-busy="true">Loading…</p>}
        <ol className="rows">
          {(rows ?? []).map((d, i) => {
            const j = saleOf.get(d.dispute_id);
            return (
              <li key={d.dispute_id} className={d.dispute_id === selectedId ? "selected" : ""}>
                <a href={`#disputes/${d.dispute_id}`}>
                  <span className="ledger-no serif">{String(i + 1).padStart(2, "0")}</span>
                  <span className="row-icon"><Icon name="shield" size={26} /></span>
                  <span className="row-main">
                    <strong className="clamp1">{human(d.reason) || "Dispute"}</strong>
                    <span className="clamp1 jp">{j ? `${j.id} · ${j.title_ja ?? j.title_en}` : d.dispute_id}</span>
                    <span className="muted clamp1">{human(d.status)} · {money(d.amount)}{d.seller_response_due_date ? ` · respond by ${d.seller_response_due_date.slice(0, 10)}` : ""}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ol>
        {rows && rows.length === 0 && <p className="empty-note">No disputes. They appear here when a buyer opens one{health.paypal.offline ? " (use Simulate dispute on a paid journey)" : " (in the sandbox: Resolution Center of the buyer account)"}.</p>}
      </section>
      <section className="inbox-detail" aria-label="Dispute">
        {selectedId ? <DisputeCase key={selectedId} disputeId={selectedId} journey={saleOf.get(selectedId)} refresh={refresh} /> : <p className="empty-note">Select a dispute.</p>}
      </section>
    </div>
  );
}

function DisputeCase({ disputeId, journey, refresh }: { disputeId: string; journey?: Journey; refresh: () => Promise<void> }) {
  const [detail, setDetail] = useState<DisputeDetail | null>(null);
  const [form, setForm] = useState({
    invoice_id: journey?.invoice_id ?? "",
    carrier: journey?.tracking?.carrier ?? "Japan Post",
    tracking_number: journey?.tracking?.number ?? "",
    shipped_date: journey?.tracking?.at?.slice(0, 10) ?? "",
    seller_notes: "",
  });
  const [result, setResult] = useState<PackResult | null>(null);
  const [accept, setAccept] = useState<Proposal | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const load = useAction(async () => setDetail(await api.get<DisputeDetail>(`/api/disputes/${encodeURIComponent(disputeId)}`)));
  useEffect(() => void load.run(), [disputeId]);

  const build = useAction(async () => {
    const body = {
      ...(form.invoice_id ? { invoice_id: form.invoice_id } : {}),
      ...(form.tracking_number ? { tracking: { carrier: form.carrier, tracking_number: form.tracking_number, ...(form.shipped_date ? { shipped_date: form.shipped_date } : {}) } } : {}),
      ...(form.seller_notes ? { seller_notes: form.seller_notes } : {}),
    };
    setResult(await api.post<PackResult>(`/api/disputes/${encodeURIComponent(disputeId)}/evidence-pack`, body));
    await refresh();
  });
  const acceptClaim = useAction(async () => {
    setAccept((await api.post<{ proposal: Proposal }>(`/api/disputes/${encodeURIComponent(disputeId)}/accept-claim`, { note: "I accept the claim and agree to refund the buyer." })).proposal);
    await refresh();
  });

  return (
    <article className="detail">
      <a className="back mobile-only" href="#disputes">← Disputes</a>
      <header className="detail-head">
        <div>
          <h2 className="h1 serif">Evidence + reply</h2>
          <p className="muted clamp1">{journey ? `${journey.id} · ${journey.buyer} · ${journey.country_name}` : disputeId}</p>
        </div>
        {detail && <span className="tag tag-warn"><Icon name="alert" size={14} /> {human(detail.status)}</span>}
      </header>
      <div className="detail-body">
        <ErrorBox error={load.error} />
        {detail && (
          <div className="ledger">
            <div className="ledger-row"><span>Reason</span><span>{human(detail.reason)}</span></div>
            <div className="ledger-row"><span>Stage</span><span>{human(detail.stage)}</span></div>
            <div className="ledger-row"><span>Amount</span><span className="num">{money(detail.amount)}</span></div>
            {detail.seller_response_due_date && <div className="ledger-row"><span>Respond by</span><span>{detail.seller_response_due_date.slice(0, 10)}</span></div>}
            <div className="ledger-row"><span>PayPal allows now</span><span>{(Object.keys(detail.allowed_actions) as Array<keyof DisputeDetail["allowed_actions"]>).filter((k) => detail.allowed_actions[k].allowed).map(human).join(", ") || "nothing"}</span></div>
          </div>
        )}
        {detail && detail.messages.length > 0 && (
          <div className="messages">
            <p className="ledger-cap">Messages (contact details removed)</p>
            {detail.messages.map((m, i) => (
              <p key={i}><strong>{human(m.posted_by)}</strong> <span className="muted">{m.time_posted?.slice(0, 10)}</span><br />{m.content}</p>
            ))}
          </div>
        )}

        <p className="ledger-cap">Facts for the evidence pack</p>
        <p className="muted small">The AI uses only these facts and PayPal's dispute data; anything it cannot back up is flagged.</p>
        <div className="field-row">
          <label className="field"><span>Invoice id</span><input value={form.invoice_id} onChange={set("invoice_id")} /></label>
          <label className="field"><span>Carrier</span><input value={form.carrier} onChange={set("carrier")} /></label>
          <label className="field"><span>Tracking number</span><input value={form.tracking_number} onChange={set("tracking_number")} /></label>
          <label className="field"><span>Shipped on (YYYY-MM-DD)</span><input value={form.shipped_date} onChange={set("shipped_date")} /></label>
        </div>
        <label className="field"><span>Notes for the AI (Japanese or English)</span><textarea value={form.seller_notes} maxLength={2000} onChange={set("seller_notes")} /></label>
        <div className="decision">
          <button className="btn btn-outline" disabled={acceptClaim.busy} onClick={() => void acceptClaim.run()}>Prepare: accept claim and refund…</button>
          <button className="btn btn-primary" disabled={build.busy} onClick={() => void build.run()}>{build.busy ? "Building…" : "Build evidence pack with AI"}</button>
        </div>
        <ErrorBox error={build.error ?? acceptClaim.error} />
        {accept && (
          <div className="proposal-block">
            <p><strong>Accept claim and refund</strong> · {(accept.payload as { note?: string }).note}</p>
            <DecisionButtons proposal={accept} onDone={(p) => { setAccept(p); void refresh(); }} />
            <ProposalOutcome proposal={accept} />
          </div>
        )}

        {result && (
          <div className="pack">
            <p className="ai-row"><ModelChip by={result.pack.generated_by} /> <span>Recommended: {human(result.pack.recommended_action)}</span></p>
            {result.pack.unverified_facts.length > 0 && (
              <div className="error" role="alert"><Icon name="alert" /><div>Check before sending: not in the PayPal data or your inputs: {result.pack.unverified_facts.join(", ")}</div></div>
            )}
            <p>{result.pack.summary}</p>
            {result.pack.missing_information.length > 0 && <p className="muted">Missing: {result.pack.missing_information.join("; ")}</p>}
            <div className="ledger">
              {result.pack.timeline.map((t, i) => (
                <div className="ledger-row" key={i}><span className="num">{t.date}</span><span>{t.event} <span className="muted">({t.source})</span></span></div>
              ))}
            </div>
            <p className="muted small">Attachments: {result.pack.attachments.map((a) => `${a.name} (${a.description})`).join(", ") || "none"}</p>
            {result.proposals.provide_evidence ? (
              <ProposalBlock title="Submit evidence" proposal={result.proposals.provide_evidence} text={result.pack.evidence_notes} refresh={refresh} />
            ) : (
              <p className="muted small">No evidence proposal: {result.allowed_actions.provide_evidence.reason}</p>
            )}
            {result.proposals.send_message ? (
              <ProposalBlock title="Send reply to the buyer" proposal={result.proposals.send_message} text={result.pack.reply_draft} refresh={refresh} />
            ) : (
              <>
                <p className="muted small">No message proposal: {result.allowed_actions.send_message.reason}</p>
                <CopyForDm text={result.pack.reply_draft} />
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function ProposalBlock({ title, proposal, text, refresh }: { title: string; proposal: Proposal; text: string; refresh: () => Promise<void> }) {
  const [p, setP] = useState(proposal);
  return (
    <div className="proposal-block">
      <p><strong>{title}</strong></p>
      <p className="pre">{text}</p>
      <PayloadDetails proposal={p} />
      <DecisionButtons proposal={p} onDone={(next) => { setP(next); void refresh(); }} />
      <ProposalOutcome proposal={p} />
    </div>
  );
}
