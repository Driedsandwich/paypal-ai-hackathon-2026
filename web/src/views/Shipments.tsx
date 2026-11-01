import { useState } from "react";
import { api, type Health, type Proposal } from "../api";
import { ErrorBox, ProposalCard, useAction } from "../components";

export function ShipmentsView({ health, onProposal }: { health: Health; onProposal: () => void }) {
  const [kind, setKind] = useState<"invoice" | "order">(health.paymentPath);
  const [form, setForm] = useState({ invoice_id: "", transaction_id: "", order_id: "", capture_id: "", carrier: "Japan Post", tracking_number: "" });
  const [order, setOrder] = useState<{ id: string; status: string; captures: Array<{ id: string; status: string }> } | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  const lookup = useAction(async () => {
    const o = await api.get<NonNullable<typeof order>>(`/api/orders/${encodeURIComponent(form.order_id)}`);
    setOrder(o);
    if (o.captures[0]) setForm((f) => ({ ...f, capture_id: o.captures[0]!.id }));
  });
  const capture = useAction(async () => {
    setProposal((await api.post<{ proposal: Proposal }>(`/api/orders/${encodeURIComponent(form.order_id)}/capture`)).proposal);
    onProposal();
  });
  const track = useAction(async () => {
    const body =
      kind === "order"
        ? { kind, order_id: form.order_id, capture_id: form.capture_id, carrier: form.carrier, tracking_number: form.tracking_number }
        : { kind, carrier: form.carrier, tracking_number: form.tracking_number, ...(form.transaction_id ? { transaction_id: form.transaction_id } : { invoice_id: form.invoice_id }) };
    setProposal((await api.post<{ proposal: Proposal }>("/api/tracking", body)).proposal);
    onProposal();
  });

  if (!health.paypal.configured) return <section className="card"><h2>Shipments</h2><p>PayPal is not configured.</p></section>;
  return (
    <section className="card">
      <h2>Shipments: record tracking with PayPal</h2>
      <p className="muted">Proof of shipment protects you in disputes. PayPal can email the tracking number to the buyer.</p>
      <label>Payment type</label>
      <select value={kind} onChange={(e) => setKind(e.target.value as "invoice" | "order")}>
        <option value="invoice">Invoice payment (Add Tracking API, transaction id)</option>
        <option value="order">Payment link (Orders v2 /track, capture id)</option>
      </select>
      {kind === "invoice" ? (
        <div className="row">
          <div><label>Invoice id (INV2-…)</label><input value={form.invoice_id} onChange={set("invoice_id")} /></div>
          <div><label>or PayPal transaction id</label><input value={form.transaction_id} onChange={set("transaction_id")} /></div>
        </div>
      ) : (
        <>
          <div className="row">
            <div><label>Order id</label><input value={form.order_id} onChange={set("order_id")} /></div>
            <div><label>Capture id</label><input value={form.capture_id} onChange={set("capture_id")} /></div>
          </div>
          <button className="secondary" disabled={!form.order_id || lookup.busy} onClick={() => void lookup.run()}>Look up order</button>
          {order && (
            <p className="muted">
              Order {order.id}: <span className="badge">{order.status}</span>{" "}
              {order.status === "APPROVED" && <button className="secondary" onClick={() => void capture.run()}>Prepare capture…</button>}
            </p>
          )}
        </>
      )}
      <div className="row">
        <div><label>Carrier (free text, e.g. Japan Post, Yamato, Sagawa)</label><input value={form.carrier} onChange={set("carrier")} /></div>
        <div><label>Tracking number</label><input value={form.tracking_number} onChange={set("tracking_number")} /></div>
      </div>
      <button className="primary" disabled={track.busy || !form.tracking_number} onClick={() => void track.run()}>Prepare tracking for approval</button>
      <ErrorBox error={track.error ?? lookup.error ?? capture.error} />
      {proposal && <ProposalCard key={proposal.id} proposal={proposal} onChange={onProposal} />}
    </section>
  );
}
