import { useCallback, useEffect, useState } from "react";
import { api, type Health, type Proposal } from "./api";
import { ErrorBox, ProposalCard } from "./components";
import { DashboardView } from "./views/Dashboard";
import { DisputesView } from "./views/Disputes";
import { InvoicesView } from "./views/Invoices";
import { NewItemView } from "./views/NewItem";
import { ShipmentsView } from "./views/Shipments";

const VIEWS = [
  { key: "new", label: "New item" },
  { key: "invoices", label: "Invoices" },
  { key: "shipments", label: "Shipments" },
  { key: "disputes", label: "Disputes" },
  { key: "dashboard", label: "Dashboard" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

function initialView(): ViewKey {
  const k = window.location.hash.replace("#", "");
  return (VIEWS.find((v) => v.key === k)?.key ?? "new") as ViewKey;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<ViewKey>(initialView);
  const [pending, setPending] = useState<Proposal[]>([]);

  const refresh = useCallback(() => {
    api.get<Health>("/api/health").then(setHealth, setError);
    api.get<Proposal[]>("/api/proposals?status=pending").then(setPending, () => setPending([]));
  }, []);
  useEffect(refresh, [refresh]);
  useEffect(() => {
    window.location.hash = view;
  }, [view]);

  if (error) return <div style={{ padding: "2rem" }}><ErrorBox error={error} /></div>;
  if (!health) return <p style={{ padding: "2rem" }}>Loading…</p>;

  const aiLabel = health.ai.provider === "fake" ? "offline demo AI" : `${health.ai.provider}${health.ai.model ? ` (${health.ai.model})` : ""}`;
  const props = { health, onProposal: refresh };
  return (
    <>
      <header>
        <h1>Okuri · AI export desk</h1>
        <span className="powered">
          Payments by PayPal ({health.paypal.configured ? `${health.paypal.env}` : "not connected"}) · AI by {aiLabel} · {health.paymentPath === "invoice" ? "Invoicing API" : "Orders API payment links"}
        </span>
      </header>
      <div className="banner" role="note"><p><strong>{health.demo.notice}</strong> Proposals you create are visible only in this browser; invoices and payment links go only to the demo buyers.</p></div>
      {health.banner.length > 0 && (
        <div className="banner" role="status">{health.banner.map((b) => <p key={b}>{b}</p>)}</div>
      )}
      <nav>
        {VIEWS.map((v) => (
          <button key={v.key} className={view === v.key ? "active" : ""} onClick={() => setView(v.key)}>{v.label}</button>
        ))}
      </nav>
      <div className="layout">
        <main>
          {view === "new" && <NewItemView {...props} />}
          {view === "invoices" && <InvoicesView {...props} />}
          {view === "shipments" && <ShipmentsView {...props} />}
          {view === "disputes" && <DisputesView {...props} />}
          {view === "dashboard" && <DashboardView {...props} />}
        </main>
        <aside className="card">
          <h2>Waiting for your approval ({pending.length})</h2>
          <p className="muted">Nothing reaches a buyer or PayPal until you approve it here. The server enforces this.</p>
          {pending.map((p) => <ProposalCard key={p.id} proposal={p} onChange={refresh} />)}
          <p className="muted">AI limits: {health.limits.perIp} requests per {health.limits.windowMinutes} min per visitor, {health.limits.usedToday}/{health.limits.dailyCap} used today.</p>
          <p className="muted">PayPal limits: {health.demoLimits.proposals} proposals and {health.demoLimits.approvals} approvals per {health.demoLimits.windowMinutes} min per visitor; {health.demoLimits.paypalWritesToday}/{health.demoLimits.paypalDailyWriteCap} PayPal actions used today.</p>
        </aside>
      </div>
    </>
  );
}
