import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { api, providerLabel, type Health, type JourneysData } from "./api";
import { ErrorBox, Icon, Seal } from "./components";
import { ApprovalsView } from "./views/Approvals";
import { DisputesView } from "./views/Disputes";
import { JourneysView } from "./views/Journeys";
import { NewItemView } from "./views/NewItem";
import { ToolsView } from "./views/Tools";

// AG Studio is large: load the Insights view only when it is opened.
const InsightsView = lazy(() => import("./views/Insights").then((m) => ({ default: m.InsightsView })));

const VIEWS = [
  { key: "journeys", label: "Journeys" },
  { key: "approvals", label: "Approvals" },
  { key: "new", label: "New item" },
  { key: "disputes", label: "Disputes" },
  { key: "insights", label: "Insights" },
] as const;
export type ViewKey = (typeof VIEWS)[number]["key"] | "tools";

export interface Route {
  view: ViewKey;
  arg?: string;
}

function parseHash(): Route {
  const [view, arg] = window.location.hash.replace(/^#\/?/, "").split("/");
  const known = [...VIEWS.map((v) => v.key), "tools"] as string[];
  return { view: (known.includes(view ?? "") ? view : "journeys") as ViewKey, ...(arg ? { arg: decodeURIComponent(arg) } : {}) };
}

export function go(route: Route): void {
  window.location.hash = `#${route.view}${route.arg ? `/${encodeURIComponent(route.arg)}` : ""}`;
}

const COUNTS = [
  { key: "draft", label: "Draft", icon: "draft" },
  { key: "invoiced", label: "Invoiced", icon: "invoice" },
  { key: "paid", label: "Paid", icon: "paid" },
  { key: "shipped", label: "Shipped", icon: "shipped" },
  { key: "disputed", label: "Disputed", icon: "disputed" },
] as const;

export interface ViewProps {
  health: Health;
  data: JourneysData | null;
  dataError: unknown;
  refresh: () => Promise<void>;
  route: Route;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [data, setData] = useState<JourneysData | null>(null);
  const [dataError, setDataError] = useState<unknown>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await api.get<JourneysData>("/api/journeys"));
      setDataError(null);
    } catch (e) {
      setDataError(e);
    }
  }, []);
  useEffect(() => {
    api.get<Health>("/api/health").then(setHealth, setError);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash());
      setMenuOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!health) return <div className="page loading" aria-busy="true">Loading…</div>;

  const pending = data?.pending_count ?? 0;
  const aiTitle = `${health.ai.provider}${health.ai.model ? ` · ${health.ai.model}` : ""}${health.ai.fallback ? ` (fallback: ${health.ai.fallback.provider}${health.ai.fallback.model ? ` · ${health.ai.fallback.model}` : ""})` : ""}`;
  const chips = (
    <>
      <span className="chip" title={health.paypal.offline ? "PayPal is simulated in memory (offline demo)" : health.paypal.configured ? `PayPal ${health.paypal.env}` : "PayPal is not configured"}>
        {health.paypal.configured ? `PayPal ${health.paypal.env === "live" ? "live" : "sandbox"}` : "PayPal not connected"}
        {health.paypal.offline && <span className="chip-sub"> · offline</span>}
      </span>
      <span className="chip" title={aiTitle}>
        {providerLabel(health.ai.provider)}
        {health.ai.fallback && <span className="chip-sub"> → {providerLabel(health.ai.fallback.provider)}</span>}
      </span>
    </>
  );
  const tabs = VIEWS.map((v) => (
    <a key={v.key} href={`#${v.key}`} className={`tab ${route.view === v.key ? "active" : ""}`} aria-current={route.view === v.key ? "page" : undefined}>
      {v.label}
      {v.key === "approvals" && pending > 0 && <span className="count-badge" aria-label={`${pending} waiting`}>{pending}</span>}
    </a>
  ));
  const props: ViewProps = { health, data, dataError, refresh, route };

  return (
    <div className="app">
      <header className="top">
        <a href="#journeys" className="brand" aria-label="Okuri home">
          <span className="wordmark">Okuri</span>
          <Seal />
        </a>
        <nav className="tabs desktop-only" aria-label="Main">{tabs}</nav>
        <div className="top-right desktop-only">
          <a className="btn btn-primary" href="#new">+ New item</a>
          {chips}
        </div>
        <button className="menu-btn mobile-only" aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen(!menuOpen)}>
          Menu <Icon name={menuOpen ? "close" : "menu"} size={22} />
        </button>
      </header>
      {menuOpen && (
        <div id="mobile-menu" className="mobile-menu mobile-only">
          <nav className="tabs" aria-label="Main">{tabs}</nav>
          <div className="mobile-menu-row">
            <a className="btn btn-primary" href="#new">+ New item</a>
            {chips}
          </div>
        </div>
      )}
      <div className="notice desktop-only">
        <span>{health.demo.notice}</span>
        <span className="notice-right">Nothing is sent until you approve.</span>
      </div>
      {health.banner.length > 0 && (
        <div className="banner desktop-only" role="status">
          {health.banner.map((b) => (
            <p key={b}><Icon name="alert" size={16} /> {b}</p>
          ))}
        </div>
      )}
      <details className="notice-mobile mobile-only">
        <summary><Icon name="alert" size={16} /> Demo mode{health.paypal.offline ? " · offline" : ""} · nothing is sent until you approve</summary>
        <p>{health.demo.notice}</p>
        {health.banner.map((b) => <p key={b}>{b}</p>)}
      </details>
      <div className="counts" aria-label="Sales by stage">
        {COUNTS.map((c) => (
          <a key={c.key} href={`#journeys`} className="count">
            <Icon name={c.icon} size={22} />
            <span className="count-label">{c.label}</span>
            <span className="count-num serif">{data ? data.counts[c.key] : "–"}</span>
          </a>
        ))}
      </div>
      <main className="page">
        {route.view === "journeys" && <JourneysView {...props} />}
        {route.view === "approvals" && <ApprovalsView {...props} />}
        {route.view === "new" && <NewItemView {...props} />}
        {route.view === "disputes" && <DisputesView {...props} />}
        {route.view === "insights" && (
          <Suspense fallback={<p className="loading" aria-busy="true">Loading Insights…</p>}>
            <InsightsView {...props} />
          </Suspense>
        )}
        {route.view === "tools" && <ToolsView {...props} />}
      </main>
      <footer className="foot">
        <span>Okuri · an AI export desk with PayPal (sandbox). AI: {providerLabel(health.ai.provider)}{health.ai.model ? ` (${health.ai.model})` : ""}.</span>
        <a href="#tools">Ask Okuri, webhook events, seed data</a>
        <span className="muted">
          Limits: {health.limits.usedToday}/{health.limits.dailyCap} model calls today · {health.demoLimits.paypalWritesToday}/{health.demoLimits.paypalDailyWriteCap} PayPal actions today
        </span>
      </footer>
    </div>
  );
}
