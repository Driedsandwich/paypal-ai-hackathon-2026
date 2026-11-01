import { useEffect, useRef, useState } from "react";
import { api, money, providerLabel, shortTime, type Health, type Journey, type JourneyAction, type Proposal } from "../api";
import { go, type ViewProps } from "../App";
import { CopyForDm, DecisionButtons, ErrorBox, Icon, KIND_LABEL, ProposalOutcome, ProposalSummary, useAction } from "../components";

/** The S3 journey home: one sale at a time, from the seller in Japan to the buyer abroad. */
export function JourneysView({ health, data, dataError, refresh, route }: ViewProps) {
  const journeys = data?.journeys ?? [];
  const index = Math.max(0, journeys.findIndex((j) => j.id === route.arg));
  const journey = journeys[index];

  if (!data && !dataError) return <p className="loading" aria-busy="true">Loading journeys…</p>;
  return (
    <div className="journey-page">
      <ErrorBox error={dataError} />
      {data?.warnings.map((w) => <div key={w} className="warning" role="status"><Icon name="alert" /> {w}</div>)}
      {journey ? (
        <JourneyDetail key={journey.id} journey={journey} health={health} refresh={refresh} index={index} total={journeys.length} prevId={journeys[index - 1]?.id} nextId={journeys[index + 1]?.id} />
      ) : (
        <EmptyJourney health={health} refresh={refresh} />
      )}
      {journeys.length > 1 && (
        <section className="sale-list" aria-label="All journeys">
          <h2 className="h3">All journeys</h2>
          <ol>
            {journeys.map((j) => (
              <li key={j.id} className={j.id === journey?.id ? "selected" : ""}>
                <a href={`#journeys/${j.id}`}>
                  <span className="num muted">{j.id}</span>
                  <span className="clamp1 jp">{j.title_ja ?? j.title_en}</span>
                  <span className="muted clamp1">{j.country_name}</span>
                  <span className="muted">{j.steps[Math.min(j.current_step, 5) - 1]?.name}{j.current_step > 5 ? " ✓" : ""}{j.dispute?.open ? " · disputed" : ""}</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function EmptyJourney({ health, refresh }: { health: Health; refresh: () => Promise<void> }) {
  const seed = useAction(async () => {
    await api.post("/api/demo/seed");
    await refresh();
    go({ view: "approvals" });
  });
  const steps = ["Draft", "Invoice", "Paid", "Tracking", "Delivered"];
  return (
    <section className="journey empty">
      <div className="sale-head">
        <div className="sale-title">
          <h1 className="serif">No sale yet</h1>
          <p className="muted">Start with a Japanese item: the AI drafts the English listing, then you follow the sale here.</p>
        </div>
      </div>
      <div className="track-wrap">
        <div className="track" style={{ ["--current" as string]: 0 }}>
          <div className="track-line" />
          {steps.map((s, i) => (
            <div key={s} className="step todo">
              <span className="mark">{i + 1}</span>
              <span className="step-name">{i + 1}. {s}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="empty-actions">
        <a className="btn btn-primary" href="#new">+ New item</a>
        {health.paypal.configured && !health.paypal.offline && health.demo.buyers.length > 0 && (
          <button className="btn btn-outline" disabled={seed.busy} onClick={() => void seed.run()}>Seed demo data (needs your approval)</button>
        )}
      </div>
      <ErrorBox error={seed.error} />
    </section>
  );
}

interface DetailProps {
  journey: Journey;
  health: Health;
  refresh: () => Promise<void>;
  index: number;
  total: number;
  prevId?: string;
  nextId?: string;
}

function JourneyDetail({ journey: j, health, refresh, index, total, prevId, nextId }: DetailProps) {
  const scroller = useRef<HTMLDivElement>(null);
  // Mobile: keep the current step in view (previous step as a sliver on the left).
  useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const stepWidth = el.scrollWidth / 5;
    el.scrollLeft = Math.max(0, (Math.min(j.current_step, 5) - 2) * stepWidth);
  }, [j.id, j.current_step]);

  const progress = Math.min(j.current_step, 5); // vermilion line up to the current step
  const later = j.steps.filter((s) => s.n > Math.min(j.current_step, 5) + 1).map((s) => s.name);
  return (
    <section className="journey" aria-label={`Journey ${j.id}`}>
      <div className="sale-head">
        <a className={`btn btn-outline nav-prev ${prevId ? "" : "disabled"}`} href={prevId ? `#journeys/${prevId}` : undefined} aria-disabled={!prevId}>
          ← <span className="desktop-only">Previous</span>
        </a>
        <div className="sale-title">
          <h1 className="serif" title={`${j.id} · ${j.title_ja ?? j.title_en}`}>
            <span className="sale-no">{j.id}</span>
            <span className="sep desktop-only"> · </span>
            <span className="jp clamp2">{j.title_ja ?? j.title_en}</span>
          </h1>
          <p className="sale-meta">
            <span className="clamp1 buyer" title={j.buyer}>{j.buyer || "Buyer not chosen yet"}</span>
            <span className="dot">·</span>
            <span>{j.country_name}</span>
            {j.amount && (
              <>
                <span className="dot">·</span>
                <span className="num">{money(j.amount)}</span>
              </>
            )}
          </p>
          {j.title_ja && <p className="sale-en muted clamp1">{j.title_en}</p>}
          <p className="route mobile-only muted">Japan → {j.country_name}</p>
          <p className="sr-only">Sale {index + 1} of {total}</p>
        </div>
        <a className={`btn btn-outline nav-next ${nextId ? "" : "disabled"}`} href={nextId ? `#journeys/${nextId}` : undefined} aria-disabled={!nextId}>
          <span className="desktop-only">Next</span> →
        </a>
      </div>

      <div className="track-area">
        <div className="callout-row" style={{ ["--cols" as string]: 5 }}>
          <div className="end end-left desktop-only">
            <strong>Japan</strong>
            <span>Seller</span>
          </div>
          {j.hint && j.callout?.step !== j.hint.step && (
            <div className="hint desktop-only" style={{ gridColumn: j.hint.step }}>
              <strong>{providerLabel(health.ai.provider)}</strong>
              <span>{j.hint.text}</span>
            </div>
          )}
          {j.callout && (
            <div className={`callout ${j.callout.step === 5 ? "at-end" : j.callout.step === 1 ? "at-start" : ""}`} style={{ gridColumn: j.callout.step }}>
              <Callout journey={j} health={health} refresh={refresh} />
            </div>
          )}
          <div className="end end-right desktop-only">
            <strong className="clamp1">{j.country_name}</strong>
            <span>Buyer</span>
          </div>
        </div>

        <div className="track-wrap" ref={scroller}>
          <div className="track" style={{ ["--current" as string]: progress }}>
            <div className="track-line" />
            <div className="track-progress" />
            {j.steps.map((s) => (
              <div key={s.n} className={`step ${s.state}`} aria-current={s.state === "current" ? "step" : undefined}>
                <span className="mark">{s.state === "done" ? <Icon name="check" size={22} /> : s.n}</span>
                <span className="step-name">{s.n}. {s.name}</span>
                <span className={`step-label ${s.state === "current" ? "accent" : "muted"}`}>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="swipe mobile-only" aria-hidden="true">
          {later.length > 0 ? <span>Swipe to {later.join(" and ")} →</span> : <span>&nbsp;</span>}
          <span className="dots">{[0, 1, 2].map((d) => <i key={d} className={d === Math.min(2, Math.floor((Math.min(j.current_step, 5) - 1) / 2)) ? "on" : ""} />)}</span>
        </div>

        <DisputeBranch journey={j} health={health} refresh={refresh} />
      </div>

      <section className="activity" aria-label="Activity log">
        <h2 className="h3">Activity log</h2>
        <ol>
          {j.activity.map((a, i) => (
            <li key={i}>
              <time dateTime={a.at}>{shortTime(a.at)}</time>
              <span>{a.text}</span>
            </li>
          ))}
          {j.activity.length === 0 && <li className="muted">Nothing yet.</li>}
        </ol>
      </section>
    </section>
  );
}

const ACTION_LABEL: Record<JourneyAction, string> = {
  prepare_invoice: "Prepare invoice",
  remind: "Prepare reminder",
  add_tracking: "Add tracking",
  build_evidence: "Build evidence pack",
  simulate_payment: "Simulate buyer payment",
  simulate_dispute: "Simulate dispute",
  simulate_delivery: "Simulate delivery",
};

function calloutHead(j: Journey, p?: Proposal): { who: string; state: string } {
  if (p?.kind === "create_and_send_invoice" || p?.kind === "create_payment_link") return { who: providerLabel(j.drafted_by?.provider) || "Okuri", state: "Draft ready" };
  if (p?.kind === "send_invoice_reminder") return { who: "Okuri", state: "Reminder ready" };
  if (p?.kind === "add_invoice_tracking" || p?.kind === "add_order_tracking") return { who: "Okuri", state: "Tracking ready" };
  if (p) return { who: "Okuri", state: KIND_LABEL[p.kind] ?? "Ready" };
  return { who: "Next step", state: j.steps[j.current_step - 1]?.label ?? "" };
}

function Callout({ journey: j, health, refresh }: { journey: Journey; health: Health; refresh: () => Promise<void> }) {
  const c = j.callout!;
  if (c.kind === "proposal") {
    const p = c.proposal;
    const head = calloutHead(j, p);
    return (
      <div className="callout-box" role="group" aria-label={`${KIND_LABEL[p.kind] ?? "Proposal"} for ${j.id}`}>
        <p className="callout-head"><strong>{head.who}</strong> · <span className="muted">{head.state}</span></p>
        <p className="callout-title clamp2">{p.kind === "create_and_send_invoice" || p.kind === "create_payment_link" ? j.title_en : KIND_LABEL[p.kind]}</p>
        <ProposalSummary proposal={p} compact />
        {p.copy_for_dm && <CopyForDm text={p.copy_for_dm} />}
        <DecisionButtons proposal={p} onDone={() => void refresh()} secondary={<a className="btn btn-outline" href={`#approvals/${p.id}`}>Review</a>} />
        <ProposalOutcome proposal={p} />
      </div>
    );
  }
  return <ActionCallout journey={j} health={health} refresh={refresh} actions={c.actions} problem={c.problem} />;
}

function ActionCallout({ journey: j, health, refresh, actions, problem }: { journey: Journey; health: Health; refresh: () => Promise<void>; actions: JourneyAction[]; problem?: Proposal }) {
  const [buyer, setBuyer] = useState(health.demo.buyers[0]?.alias ?? "");
  const [carrier, setCarrier] = useState("Japan Post");
  const [number, setNumber] = useState("");
  const run = useAction(async (action: JourneyAction) => {
    if (action === "prepare_invoice" && j.listing) {
      const path = health.paymentPath === "order" ? "/api/payment-links/prepare" : "/api/invoices/prepare";
      await api.post(path, { sale_id: j.id, listing: j.listing, buyer: { alias: buyer }, country: j.country });
    } else if (action === "remind" && j.invoice_id) {
      await api.post("/api/invoices/nudge", { invoice_ids: [j.invoice_id] });
    } else if (action === "add_tracking") {
      const body = j.path === "order" ? { kind: "order", order_id: j.order_id, capture_id: j.capture_id, carrier, tracking_number: number } : { kind: "invoice", invoice_id: j.invoice_id, carrier, tracking_number: number };
      await api.post("/api/tracking", body);
    } else if (action.startsWith("simulate_")) {
      await api.post("/api/offline/simulate", { sale_id: j.id, action: action.replace("simulate_", "") });
    }
    await refresh();
  });
  const step = j.steps[j.current_step - 1];
  return (
    <div className="callout-box" role="group" aria-label={`Next step for ${j.id}`}>
      <p className="callout-head"><strong>{step?.name}</strong> · <span className="muted">{step?.label}</span></p>
      {problem && <ProposalOutcome proposal={problem} />}
      {actions.includes("prepare_invoice") && (
        <>
          <p className="callout-title clamp2">{j.title_en}</p>
          <p className="muted small">Drafted by {providerLabel(j.drafted_by?.provider)} · {money(j.listing?.price)}</p>
          <label className="field">
            <span>Buyer</span>
            <select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
              {health.demo.buyers.length === 0 && <option value="">No demo buyers (DEMO_BUYER_EMAILS)</option>}
              {health.demo.buyers.map((b) => <option key={b.alias} value={b.alias}>{b.alias}</option>)}
            </select>
          </label>
        </>
      )}
      {actions.includes("add_tracking") && (
        <div className="field-row">
          <label className="field"><span>Carrier</span><input value={carrier} maxLength={64} onChange={(e) => setCarrier(e.target.value)} /></label>
          <label className="field"><span>Tracking number</span><input value={number} maxLength={64} placeholder="EJ123456789JP" onChange={(e) => setNumber(e.target.value)} /></label>
        </div>
      )}
      {j.current_step === 5 && !health.paypal.offline && <p className="muted small">PayPal does not report delivery to this app; the parcel is on its way.</p>}
      <div className="decision">
        {actions.map((a, i) => (
          <button
            key={a}
            className={`btn ${i === 0 && !a.startsWith("simulate_") ? "btn-primary" : "btn-outline"}`}
            disabled={run.busy || (a === "add_tracking" && !number.trim()) || (a === "prepare_invoice" && !buyer)}
            onClick={() => void run.run(a)}
          >
            {run.busy ? "Working…" : ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {actions.some((a) => a.startsWith("simulate_")) && <p className="muted small">Simulate = act as the buyer in the offline demo.</p>}
      <ErrorBox error={run.error} />
    </div>
  );
}

function DisputeBranch({ journey: j, health, refresh }: { journey: Journey; health: Health; refresh: () => Promise<void> }) {
  const simulate = useAction(async () => {
    await api.post("/api/offline/simulate", { sale_id: j.id, action: "dispute" });
    await refresh();
  });
  const d = j.dispute;
  if (!d && !(j.current_step >= 3 && j.steps[2]?.state === "done")) {
    // Not paid yet: the possible branch, quietly.
    return (
      <div className="branch-row potential" style={{ ["--from" as string]: 4 }}>
        <div className="branch">
          <span className="branch-line" />
          <span className="branch-label muted">If disputed</span>
          <div className="branch-card muted">
            <Icon name="doc" size={22} />
            <div><strong>Evidence + reply</strong><span>Review before approval</span></div>
          </div>
        </div>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="branch-row potential" style={{ ["--from" as string]: Math.min(j.current_step, 4) }}>
        <div className="branch">
          <span className="branch-line" />
          <span className="branch-label muted">If disputed</span>
          <div className="branch-card">
            <Icon name="doc" size={22} />
            <div>
              <strong>Evidence + reply</strong>
              <span>Review before approval</span>
              {j.can_simulate_dispute && (
                <button className="btn btn-ghost btn-small" disabled={simulate.busy} onClick={() => void simulate.run()}>Simulate dispute</button>
              )}
            </div>
          </div>
        </div>
        <ErrorBox error={simulate.error} />
      </div>
    );
  }
  return (
    <div className="branch-row active" style={{ ["--from" as string]: d.from_step }}>
      <div className="branch">
        <span className="branch-line" />
        <span className="branch-label">{d.open ? "Disputed" : "Dispute closed"}</span>
        <div className={`branch-card ${d.open ? "open" : ""}`} role="group" aria-label="Dispute">
          <Icon name={d.open ? "disputed" : "doc"} size={22} />
          <div>
            <strong>Evidence + reply</strong>
            <span>
              {(d.reason ?? "Dispute").replace(/_/g, " ").toLowerCase()} · {money(d.amount)}
              {d.stage ? ` · ${d.stage.toLowerCase()}` : ""}
            </span>
            {d.due && d.open && <span className="warn-text"><Icon name="alert" size={14} /> Respond by {d.due.slice(0, 10)}</span>}
            {d.proposals.map((p) => (
              <div key={p.id} className="branch-proposal">
                <span>{KIND_LABEL[p.kind]}</span>
                <DecisionButtons proposal={p} onDone={() => void refresh()} />
              </div>
            ))}
            {d.open && d.proposals.length === 0 && <a className="btn btn-outline btn-small" href={`#disputes/${d.dispute_id}`}>Build evidence pack</a>}
          </div>
        </div>
      </div>
      {health.paypal.offline && null}
    </div>
  );
}
