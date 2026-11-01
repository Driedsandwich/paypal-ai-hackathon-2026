import { useEffect, useState } from "react";
import { api, type GeneratedBy, type Proposal } from "../api";
import type { ViewProps } from "../App";
import { DecisionButtons, ErrorBox, KIND_LABEL, ModelChip, useAction } from "../components";

interface LoggedEvent {
  id: string;
  eventType: string;
  category: string;
  receivedAt: string;
  summary: string;
}

/** Secondary tools: free chat with the agent, the webhook log and the sandbox seed. */
export function ToolsView({ health, refresh }: ViewProps) {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [chatProposals, setChatProposals] = useState<Proposal[]>([]);
  const [by, setBy] = useState<GeneratedBy>();
  const loadEvents = useAction(async () => setEvents(await api.get<LoggedEvent[]>("/api/events")));
  const send = useAction(async () => {
    const next = [...messages, { role: "user" as const, content: input }];
    setMessages(next);
    setInput("");
    const res = await api.post<{ reply: string; proposals: Proposal[]; generated_by: GeneratedBy }>("/api/chat", { messages: next.slice(-20) });
    setMessages([...next, { role: "assistant", content: res.reply }]);
    setBy(res.generated_by);
    if (res.proposals.length) {
      setChatProposals((p) => [...res.proposals, ...p]);
      await refresh();
    }
  });
  const seed = useAction(async () => {
    await api.post("/api/demo/seed");
    await refresh();
    window.location.hash = "#approvals";
  });
  useEffect(() => void loadEvents.run(), []);

  return (
    <div className="form-page">
      <header className="page-head">
        <h1 className="serif">Ask Okuri</h1>
        <p className="muted">Free chat with the agent (Japanese or English). It can look things up in PayPal; anything it wants to send becomes a proposal in your Approvals.</p>
      </header>
      <section className="sheet" aria-label="Chat">
        {by && <p className="ai-row"><ModelChip by={by} /> <span>answered the last message</span></p>}
        <div className="chat-log">
          {messages.map((m, i) => (
            <p key={i}><strong>{m.role === "user" ? "You" : "Okuri"}:</strong> <span className="pre">{m.content}</span></p>
          ))}
          {messages.length === 0 && <p className="muted">例: 未払いの請求書を見せて / Show unpaid invoices</p>}
        </div>
        <label className="field">
          <span className="sr-only">Message</span>
          <input value={input} maxLength={4000} placeholder="Message Okuri…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) void send.run(); }} />
        </label>
        <div className="decision">
          <button className="btn btn-primary" disabled={send.busy || !input.trim()} onClick={() => void send.run()}>{send.busy ? "Thinking…" : "Send"}</button>
        </div>
        <ErrorBox error={send.error} />
        {chatProposals.map((p) => (
          <div className="proposal-block" key={p.id}>
            <p><strong>{KIND_LABEL[p.kind] ?? p.kind}</strong> · {p.title}</p>
            <DecisionButtons proposal={p} onDone={() => void refresh()} />
          </div>
        ))}
      </section>

      <section className="sheet" aria-label="PayPal webhook events">
        <h2 className="h3">PayPal webhook events</h2>
        <div className="ledger">
          {events.map((e) => (
            <div className="ledger-row" key={e.id}><span className="num">{e.receivedAt.slice(0, 16).replace("T", " ")}</span><span>{e.category} · {e.summary}</span></div>
          ))}
        </div>
        {events.length === 0 && <p className="muted small">No events yet. PayPal sends INVOICING.INVOICE.PAID, PAYMENT.CAPTURE.COMPLETED and CUSTOMER.DISPUTE.* to /webhooks/paypal.</p>}
        <div className="decision"><button className="btn btn-ghost btn-small" onClick={() => void loadEvents.run()}>Refresh</button></div>
      </section>

      {health.paypal.configured && !health.paypal.offline && (
        <section className="sheet" aria-label="Seed demo data">
          <h2 className="h3">Seed demo data</h2>
          <p className="muted small">Proposes four sample {health.paymentPath === "invoice" ? "invoices" : "payment links"} for the demo buyers in the PayPal sandbox; each becomes a journey after you approve.</p>
          <div className="decision"><button className="btn btn-outline" disabled={seed.busy || health.demo.buyers.length === 0} onClick={() => void seed.run()}>Prepare seed (needs approval)</button></div>
          <ErrorBox error={seed.error} />
        </section>
      )}
    </div>
  );
}
