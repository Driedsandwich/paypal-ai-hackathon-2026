import { useEffect, useState } from "react";
import { api, type Health } from "../api";
import { AiBadge, ErrorBox, ProposalCard, useAction } from "../components";
import type { Proposal } from "../api";

interface LoggedEvent { id: string; eventType: string; category: string; receivedAt: string; summary: string }

/** Placeholder: the AG Studio (AG Grid) dashboard is built in the next pass. */
export function DashboardView({ health, onProposal }: { health: Health; onProposal: () => void }) {
  const [events, setEvents] = useState<LoggedEvent[]>([]);
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [input, setInput] = useState("");
  const [chatProposals, setChatProposals] = useState<Proposal[]>([]);
  const [by, setBy] = useState<{ provider: string; model?: string }>();
  const loadEvents = useAction(async () => setEvents(await api.get<LoggedEvent[]>("/api/events")));
  const send = useAction(async () => {
    const next = [...messages, { role: "user" as const, content: input }];
    setMessages(next);
    setInput("");
    const res = await api.post<{ reply: string; proposals: Proposal[]; generated_by: { provider: string; model?: string } }>("/api/chat", { messages: next.slice(-20) });
    setMessages([...next, { role: "assistant", content: res.reply }]);
    setBy(res.generated_by);
    if (res.proposals.length) {
      setChatProposals((p) => [...res.proposals, ...p]);
      onProposal();
    }
  });
  useEffect(() => void loadEvents.run(), []);

  return (
    <>
      <section className="card">
        <h2>Dashboard</h2>
        <div className="watermark" data-mark={health.agStudio.licensed ? "" : "AG Studio · unlicensed preview"}>
          <p className="muted">Sales dashboard (built with AG Studio from AG Grid) arrives in the next pass.{!health.agStudio.licensed && " AG_STUDIO_LICENSE is not set, so it will show a watermark."}</p>
        </div>
      </section>
      <section className="card">
        <h2>PayPal webhook events</h2>
        <button className="secondary" onClick={() => void loadEvents.run()}>Refresh</button>
        <ErrorBox error={loadEvents.error} />
        <table>
          <tbody>
            {events.map((e) => <tr key={e.id}><td className="muted">{e.receivedAt.slice(0, 19).replace("T", " ")}</td><td><span className="badge">{e.category}</span></td><td>{e.summary}</td></tr>)}
            {events.length === 0 && <tr><td className="muted">No events yet. PayPal sends INVOICING.INVOICE.PAID, PAYMENT.CAPTURE.COMPLETED and CUSTOMER.DISPUTE.* here.</td></tr>}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Ask Okuri <AiBadge by={by} /></h2>
        <p className="muted">Free chat with the agent. It can look things up in PayPal; anything it wants to send becomes a proposal for you to approve.</p>
        <div className="chat-log">{messages.map((m, i) => <p key={i}><strong>{m.role === "user" ? "You" : "Okuri"}:</strong> {m.content}</p>)}</div>
        <div className="row">
          <input value={input} maxLength={4000} placeholder="例: 未払いの請求書を見せて / Show unpaid invoices" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && input.trim()) void send.run(); }} />
        </div>
        <button className="primary" disabled={send.busy || !input.trim()} onClick={() => void send.run()}>Send</button>
        <ErrorBox error={send.error} />
        {chatProposals.map((p) => <ProposalCard key={p.id} proposal={p} onChange={onProposal} />)}
      </section>
    </>
  );
}
