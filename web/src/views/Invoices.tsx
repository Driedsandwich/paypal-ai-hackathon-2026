import { useEffect, useState } from "react";
import { api, type Health, type Money, type Proposal } from "../api";
import { AiBadge, ErrorBox, ProposalCard, useAction } from "../components";

interface Row {
  id: string;
  invoice_number?: string;
  status?: string;
  invoice_date?: string;
  amount?: Partial<Money>;
  due_amount?: Money;
  recipient_email?: string;
  item_names: string[];
  transaction_ids: string[];
}

export function InvoicesView({ health, onProposal }: { health: Health; onProposal: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [nudges, setNudges] = useState<{ proposals: Proposal[]; generated_by?: { provider: string; model?: string } } | null>(null);
  const [seed, setSeed] = useState<Proposal | null>(null);
  const load = useAction(async () => setRows((await api.get<{ invoices: Row[] }>("/api/invoices")).invoices));
  const nudge = useAction(async () => {
    setNudges(await api.post("/api/invoices/nudge", {}));
    onProposal();
  });
  const seeder = useAction(async () => {
    setSeed((await api.post<{ proposal: Proposal }>("/api/demo/seed")).proposal);
    onProposal();
  });
  useEffect(() => {
    if (health.paypal.configured) void load.run();
  }, [health.paypal.configured]);

  if (!health.paypal.configured) return <section className="card"><h2>Invoices</h2><p>PayPal is not configured, so there are no invoices to show.</p></section>;
  if (health.paymentPath === "order") {
    return (
      <section className="card">
        <h2>Invoices</h2>
        <p>This server uses the Orders v2 payment-link path (<code>PAYMENT_PATH=order</code>). Payment links are created from the New item view; track them in Shipments.</p>
        <button className="secondary" disabled={seeder.busy} onClick={() => void seeder.run()}>Seed demo payment links…</button>
        <ErrorBox error={seeder.error} />
        {seed && <ProposalCard proposal={seed} onChange={onProposal} />}
      </section>
    );
  }
  return (
    <section className="card">
      <h2>Invoices (live from the PayPal sandbox)</h2>
      <button className="secondary" disabled={load.busy} onClick={() => void load.run()}>Refresh</button>
      <button className="primary" disabled={nudge.busy} onClick={() => void nudge.run()}>{nudge.busy ? "Drafting…" : "Draft reminders for unpaid invoices (AI)"}</button>
      <button className="secondary" disabled={seeder.busy} onClick={() => void seeder.run()} title="Creates sample invoices to the sandbox buyers in DEMO_BUYER_EMAILS, after your approval">Seed demo data…</button>
      <ErrorBox error={load.error ?? nudge.error ?? seeder.error} />
      {seed && <ProposalCard proposal={seed} onChange={() => { onProposal(); void load.run(); }} />}
      {rows && (
        <table>
          <thead><tr><th>Number</th><th>Status</th><th>Date</th><th>Amount</th><th>Buyer</th><th>Items</th><th>Transaction</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td title={r.id}>{r.invoice_number ?? r.id}</td>
                <td><span className={`badge ${r.status === "PAID" ? "ok" : r.status === "SENT" || r.status === "UNPAID" ? "warn" : ""}`}>{r.status}</span></td>
                <td>{r.invoice_date}</td>
                <td>{r.amount?.value} {r.amount?.currency_code}</td>
                <td>{r.recipient_email}</td>
                <td>{r.item_names.join(", ")}</td>
                <td><code>{r.transaction_ids.join(", ")}</code></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">No invoices yet. Create one from New item, or seed demo data.</td></tr>}
          </tbody>
        </table>
      )}
      {nudges && (
        <>
          <h3>Reminder drafts <AiBadge by={nudges.generated_by} /></h3>
          {nudges.proposals.length === 0 && <p className="muted">No unpaid invoices.</p>}
          {nudges.proposals.map((p) => <ProposalCard key={p.id} proposal={p} onChange={onProposal} />)}
        </>
      )}
    </section>
  );
}
