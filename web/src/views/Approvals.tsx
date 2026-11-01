import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Journey, type Proposal } from "../api";
import { go, type ViewProps } from "../App";
import { consequence, CopyForDm, DecisionButtons, ErrorBox, Icon, KIND_ICON, KIND_LABEL, ModelChip, PayloadDetails, ProposalOutcome, ProposalSummary, StatusTag, useAction } from "../components";

type Filter = "pending" | "done" | "all";

/** S1-style inbox: every proposal across sales on the left, the selected one on the right. */
export function ApprovalsView({ health, data, refresh, route }: ViewProps) {
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [filter, setFilter] = useState<Filter>("pending");
  const [query, setQuery] = useState("");
  const load = useAction(async () => setItems(await api.get<Proposal[]>("/api/proposals")));
  const reload = useCallback(async () => {
    await Promise.all([load.run(), refresh()]);
  }, [refresh]);
  useEffect(() => void load.run(), []);

  const bySale = useMemo(() => new Map((data?.journeys ?? []).map((j) => [j.id, j])), [data]);
  const shown = (items ?? []).filter((p) => {
    if (filter === "pending" && p.status !== "pending") return false;
    if (filter === "done" && p.status === "pending") return false;
    if (!query.trim()) return true;
    const j = p.sale_id ? bySale.get(p.sale_id) : undefined;
    const hay = `${p.title} ${KIND_LABEL[p.kind]} ${j?.title_ja ?? ""} ${j?.title_en ?? ""} ${j?.country_name ?? ""} ${j?.buyer ?? ""} ${p.sale_id ?? ""}`.toLowerCase();
    return hay.includes(query.trim().toLowerCase());
  });
  const selected = shown.find((p) => p.id === route.arg) ?? (route.arg ? items?.find((p) => p.id === route.arg) : undefined) ?? shown[0];
  const pendingCount = (items ?? []).filter((p) => p.status === "pending").length;

  return (
    <div className={`inbox ${route.arg ? "has-selection" : ""}`}>
      <section className="inbox-list" aria-label="Approval inbox">
        <div className="inbox-head">
          <h1 className="h2 serif">Approval inbox <span className="muted count-inline">{pendingCount}</span></h1>
          <div className="inbox-tools">
            <label className="sr-only" htmlFor="inbox-filter">Show</label>
            <select id="inbox-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="pending">Needs approval</option>
              <option value="done">Decided</option>
              <option value="all">All</option>
            </select>
            <label className="search">
              <Icon name="search" size={18} />
              <span className="sr-only">Search</span>
              <input value={query} placeholder="Search items, buyers, countries…" onChange={(e) => setQuery(e.target.value)} />
            </label>
          </div>
        </div>
        <ErrorBox error={load.error} />
        {!items && !load.error && <p className="loading" aria-busy="true">Loading…</p>}
        <ol className="rows">
          {shown.map((p, i) => {
            const j = p.sale_id ? bySale.get(p.sale_id) : undefined;
            return (
              <li key={p.id} className={p.id === selected?.id ? "selected" : ""}>
                <a href={`#approvals/${p.id}`} aria-current={p.id === selected?.id ? "true" : undefined}>
                  <span className="ledger-no serif">{String(i + 1).padStart(2, "0")}</span>
                  <span className="row-icon"><Icon name={KIND_ICON[p.kind] ?? "doc"} size={26} /></span>
                  <span className="row-main">
                    <strong className="clamp1">{KIND_LABEL[p.kind] ?? p.kind}</strong>
                    <span className="clamp1 jp">{j ? `${j.title_ja ?? j.title_en} · ${j.country_name}` : p.title}</span>
                    <span className="muted clamp1">{rowNote(p, j)}</span>
                  </span>
                  {p.status !== "pending" && <StatusTag status={p.status} />}
                </a>
              </li>
            );
          })}
        </ol>
        {items && shown.length === 0 && (
          <p className="empty-note">{filter === "pending" ? "Nothing waits for you. Proposals appear here when the AI prepares something for PayPal or a buyer." : "No proposals match."}</p>
        )}
      </section>
      <section className="inbox-detail" aria-label="Selected proposal">
        {selected ? <Detail key={selected.id} proposal={selected} journey={selected.sale_id ? bySale.get(selected.sale_id) : undefined} aiProvider={health.ai} onChange={reload} /> : <p className="empty-note">Select a proposal.</p>}
      </section>
    </div>
  );
}

function rowNote(p: Proposal, j?: Journey): string {
  switch (p.kind) {
    case "create_and_send_invoice":
      return `AI draft ready · ${j?.amount ? `${j.amount.currency_code} ${j.amount.value}` : ""}`;
    case "send_invoice_reminder":
      return "PayPal reminder + DM copy";
    case "add_invoice_tracking":
    case "add_order_tracking":
      return "Tracking number ready";
    case "provide_dispute_evidence":
      return "Evidence + attachments";
    case "send_dispute_message":
      return "English reply";
    default:
      return p.title;
  }
}

function Detail({ proposal, journey: j, aiProvider, onChange }: { proposal: Proposal; journey?: Journey; aiProvider: { provider: string; model: string | null }; onChange: () => Promise<void> }) {
  const [p, setP] = useState(proposal);
  const aiWritten = p.kind === "create_and_send_invoice" || p.kind === "create_payment_link" || p.kind === "send_dispute_message" || p.kind === "provide_dispute_evidence" || Boolean(p.copy_for_dm);
  const steps = [
    { label: "Item added", done: true },
    { label: aiWritten ? "Draft prepared" : "Prepared", done: true },
    { label: p.status === "pending" ? "Awaiting approval" : p.status === "executed" ? "Sent" : "Decided", done: p.status !== "pending" },
  ];
  return (
    <article className="detail">
      <a className="back mobile-only" href="#approvals" onClick={(e) => { e.preventDefault(); go({ view: "approvals" }); }}>← Inbox</a>
      <header className="detail-head">
        <div>
          <h2 className="h1 serif">{KIND_LABEL[p.kind] ?? p.kind}</h2>
          <p className="muted clamp1">{j ? `${j.id} · ${j.buyer || "buyer not chosen"} · ${j.country_name}` : p.title}</p>
        </div>
        <StatusTag status={p.status} />
      </header>
      <div className="detail-body">
        {j && (p.kind === "create_and_send_invoice" || p.kind === "create_payment_link") && (
          <div className="detail-item">
            <p className="ledger-cap">Invoice draft</p>
            <h3 className="serif detail-title">{j.title_en}</h3>
            {j.title_ja && <p className="jp detail-ja">{j.title_ja}</p>}
          </div>
        )}
        <ProposalSummary proposal={p} compact={p.kind === "create_and_send_invoice"} />
        {p.kind === "create_and_send_invoice" && (p.payload as { invoice?: { detail?: { note?: string } } }).invoice?.detail?.note && (
          <p className="note-text"><span className="muted">Note to the buyer:</span> {(p.payload as { invoice: { detail: { note: string } } }).invoice.detail.note}</p>
        )}
        {p.copy_for_dm && <CopyForDm text={p.copy_for_dm} />}
        {aiWritten && (
          <p className="ai-row">
            <ModelChip by={j?.drafted_by ?? { provider: aiProvider.provider, model: aiProvider.model }} />
            <span>{p.kind === "create_and_send_invoice" ? "I prepared the English listing, the USD price estimate and the note. Review before sending." : "I drafted the text from the PayPal data and your facts. Review before sending."}</span>
          </p>
        )}
        <ol className="mini-progress" aria-label="Progress">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? "done" : "current"}>
              <span className="mini-mark">{s.done ? <Icon name="check" size={14} /> : null}</span>
              {s.label}
            </li>
          ))}
        </ol>
        {j && <a className="link" href={`#journeys/${j.id}`}>Open journey step →</a>}
        <PayloadDetails proposal={p} />
        <ProposalOutcome proposal={p} />
        {p.status === "executed" && p.result !== undefined && (
          <details className="payload">
            <summary>PayPal result</summary>
            <pre>{JSON.stringify(p.result, null, 2)}</pre>
          </details>
        )}
      </div>
      <footer className="action-bar">
        <strong className="consequence">{consequence(p, j)}</strong>
        <DecisionButtons
          proposal={p}
          onDone={(next) => {
            setP(next);
            void onChange();
          }}
        />
      </footer>
      <ErrorBox error={null} />
    </article>
  );
}
