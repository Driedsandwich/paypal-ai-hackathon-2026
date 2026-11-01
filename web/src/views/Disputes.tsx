import { useEffect, useState } from "react";
import { api, type Health, type Money, type Proposal } from "../api";
import { AiBadge, ErrorBox, ProposalCard, useAction } from "../components";

interface DisputeRow {
  dispute_id: string;
  reason?: string;
  status?: string;
  stage?: string;
  amount?: Money;
  create_time?: string;
  seller_response_due_date?: string;
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

export function DisputesView({ health, onProposal }: { health: Health; onProposal: () => void }) {
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  const [selected, setSelected] = useState<DisputeRow | null>(null);
  const [form, setForm] = useState({ invoice_id: "", carrier: "Japan Post", tracking_number: "", shipped_date: "", seller_notes: "" });
  const [result, setResult] = useState<{ pack: Pack; proposals: { provide_evidence: Proposal; send_message: Proposal } } | null>(null);
  const [accept, setAccept] = useState<Proposal | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const load = useAction(async () => setRows((await api.get<{ disputes: DisputeRow[] }>("/api/disputes")).disputes));
  const build = useAction(async () => {
    if (!selected) return;
    const body = {
      ...(form.invoice_id ? { invoice_id: form.invoice_id } : {}),
      ...(form.tracking_number ? { tracking: { carrier: form.carrier, tracking_number: form.tracking_number, ...(form.shipped_date ? { shipped_date: form.shipped_date } : {}) } } : {}),
      ...(form.seller_notes ? { seller_notes: form.seller_notes } : {}),
    };
    setResult(await api.post(`/api/disputes/${encodeURIComponent(selected.dispute_id)}/evidence-pack`, body));
    onProposal();
  });
  const acceptClaim = useAction(async () => {
    if (!selected) return;
    setAccept((await api.post<{ proposal: Proposal }>(`/api/disputes/${encodeURIComponent(selected.dispute_id)}/accept-claim`, { note: "I accept the claim and agree to refund the buyer." })).proposal);
    onProposal();
  });
  useEffect(() => {
    if (health.paypal.configured) void load.run();
  }, [health.paypal.configured]);

  if (!health.paypal.configured) return <section className="card"><h2>Disputes</h2><p>PayPal is not configured.</p></section>;
  return (
    <section className="card">
      <h2>Disputes (live from the PayPal sandbox)</h2>
      <button className="secondary" disabled={load.busy} onClick={() => void load.run()}>Refresh</button>
      <ErrorBox error={load.error} />
      {rows && (
        <table>
          <thead><tr><th>Dispute</th><th>Reason</th><th>Status</th><th>Amount</th><th>Respond by</th><th /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.dispute_id}>
                <td><code>{d.dispute_id}</code></td>
                <td>{d.reason}</td>
                <td><span className="badge warn">{d.status}</span></td>
                <td>{d.amount?.value} {d.amount?.currency_code}</td>
                <td>{d.seller_response_due_date?.slice(0, 10)}</td>
                <td><button className="secondary" onClick={() => { setSelected(d); setResult(null); setAccept(null); }}>Open</button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6} className="muted">No disputes. In the sandbox, open one from a buyer account in the Resolution Center.</td></tr>}
          </tbody>
        </table>
      )}

      {selected && (
        <>
          <h3>Evidence pack for {selected.dispute_id}</h3>
          <p className="muted">Give the facts you have. The AI only uses these facts and PayPal's dispute data; anything it cannot back up is flagged.</p>
          <div className="row">
            <div><label>Invoice id (optional)</label><input value={form.invoice_id} onChange={set("invoice_id")} /></div>
            <div><label>Carrier</label><input value={form.carrier} onChange={set("carrier")} /></div>
            <div><label>Tracking number</label><input value={form.tracking_number} onChange={set("tracking_number")} /></div>
            <div><label>Shipped on (YYYY-MM-DD)</label><input value={form.shipped_date} onChange={set("shipped_date")} /></div>
          </div>
          <label>Notes for the AI (optional, Japanese or English)</label>
          <textarea value={form.seller_notes} maxLength={2000} onChange={set("seller_notes")} />
          <button className="primary" disabled={build.busy} onClick={() => void build.run()}>{build.busy ? "Building…" : "Build evidence pack with AI"}</button>
          <button className="danger" disabled={acceptClaim.busy} onClick={() => void acceptClaim.run()}>Prepare: accept claim and refund…</button>
          <ErrorBox error={build.error ?? acceptClaim.error} />
          {accept && <ProposalCard proposal={accept} onChange={onProposal} />}
        </>
      )}

      {result && (
        <div className="ai-note">
          <h3>Summary <AiBadge by={result.pack.generated_by} /> <span className="badge">recommended: {result.pack.recommended_action}</span></h3>
          {result.pack.unverified_facts.length > 0 && (
            <div className="error">Check before sending: these facts are not in the PayPal data or your inputs: {result.pack.unverified_facts.join(", ")}</div>
          )}
          <p>{result.pack.summary}</p>
          {result.pack.missing_information.length > 0 && <p className="muted">Missing: {result.pack.missing_information.join("; ")}</p>}
          <table><tbody>{result.pack.timeline.map((t, i) => <tr key={i}><td>{t.date}</td><td>{t.event}</td><td className="muted">{t.source}</td></tr>)}</tbody></table>
          <p className="muted">Attachments: {result.pack.attachments.map((a) => `${a.name} (${a.description})`).join(", ") || "none"}</p>
          <ProposalCard proposal={result.proposals.provide_evidence} onChange={onProposal}><p className="muted">Evidence notes: {result.pack.evidence_notes}</p></ProposalCard>
          <ProposalCard proposal={result.proposals.send_message} onChange={onProposal}><p style={{ whiteSpace: "pre-wrap" }}>{result.pack.reply_draft}</p></ProposalCard>
        </div>
      )}
    </section>
  );
}
