import { useEffect, useState } from "react";
import { api, type Health, type Proposal } from "../api";
import { AiBadge, ErrorBox, ProposalCard, useAction } from "../components";

interface JpItem {
  title_ja: string;
  description_ja: string;
  price_jpy: number;
  condition?: string;
  weight_g?: number;
}
interface Listing {
  title: string;
  description: string;
  item_specifics: Array<{ name: string; value: string }>;
  customs_description: string;
  price: { jpy: number; usd: string; fx_jpy_per_usd: number; note: string };
  hs_code: { candidate: string; label: string };
  generated_by: { provider: string; model?: string };
}
interface Prepared {
  path: "invoice" | "order";
  proposal: Proposal;
  buyer_message: { subject: string; note: string };
  generated_by: { provider: string; model?: string };
}

const EMPTY: JpItem = { title_ja: "", description_ja: "", price_jpy: 0 };

export function NewItemView({ health, onProposal }: { health: Health; onProposal: () => void }) {
  const [samples, setSamples] = useState<Array<{ key: string; item: JpItem }>>([]);
  const [item, setItem] = useState<JpItem>(EMPTY);
  const [listing, setListing] = useState<Listing | null>(null);
  const [buyer, setBuyer] = useState(health.demo.buyers[0]?.alias ?? "");
  const [price, setPrice] = useState({ currency_code: "USD", value: "" });
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  useEffect(() => {
    api.get<Array<{ key: string; item: JpItem }>>("/api/demo/items").then(setSamples, () => setSamples([]));
  }, []);

  const draft = useAction(async () => {
    const l = await api.post<Listing>("/api/listings/draft", { item: { ...item, ...(item.weight_g ? {} : { weight_g: undefined }) } });
    setListing(l);
    setPrice({ currency_code: "USD", value: l.price.usd });
    setPrepared(null);
  });
  const prepare = useAction(async () => {
    if (!listing) return;
    const p = await api.post<Prepared>("/api/invoices/prepare", {
      listing: { title: listing.title.slice(0, 127), description: listing.description.slice(0, 1000), price, quantity: 1 },
      buyer: { alias: buyer },
    });
    setPrepared(p);
    onProposal();
  });

  return (
    <section className="card">
      <h2>New item: Japanese in, English listing out</h2>
      <p className="muted">Type the item in Japanese. The AI agent writes the English listing; the app converts the price at {health.fxJpyPerUsd} JPY/USD as an estimate.</p>
      {samples.length > 0 && (
        <label>
          Sample item
          <select value="" onChange={(e) => { const s = samples.find((x) => x.key === e.target.value); if (s) { setItem({ ...EMPTY, ...s.item }); setListing(null); } }}>
            <option value="">Choose a sample…</option>
            {samples.map((s) => <option key={s.key} value={s.key}>{s.item.title_ja}</option>)}
          </select>
        </label>
      )}
      <label>商品名 (title, Japanese)</label>
      <input value={item.title_ja} maxLength={200} onChange={(e) => setItem({ ...item, title_ja: e.target.value })} />
      <label>説明 (description, Japanese)</label>
      <textarea value={item.description_ja} maxLength={4000} onChange={(e) => setItem({ ...item, description_ja: e.target.value })} />
      <div className="row">
        <div>
          <label>価格 (price, JPY)</label>
          <input type="number" min={1} value={item.price_jpy || ""} onChange={(e) => setItem({ ...item, price_jpy: Number(e.target.value) })} />
        </div>
        <div>
          <label>状態 (condition)</label>
          <select value={item.condition ?? ""} onChange={(e) => setItem({ ...item, ...(e.target.value ? { condition: e.target.value } : { condition: undefined }) })}>
            <option value="">—</option>
            <option value="new">New</option>
            <option value="handmade">Handmade</option>
            <option value="used_like_new">Used, like new</option>
            <option value="used_good">Used, good</option>
            <option value="used_fair">Used, fair</option>
          </select>
        </div>
        <div>
          <label>重さ (weight, g)</label>
          <input type="number" min={1} value={item.weight_g ?? ""} onChange={(e) => setItem({ ...item, ...(e.target.value ? { weight_g: Number(e.target.value) } : { weight_g: undefined }) })} />
        </div>
      </div>
      <button className="primary" disabled={draft.busy || !item.title_ja || !item.price_jpy} onClick={() => void draft.run()}>
        {draft.busy ? "Drafting…" : "Draft English listing with AI"}
      </button>
      <ErrorBox error={draft.error} />

      {listing && (
        <div className="ai-note">
          <h3>{listing.title} <AiBadge by={listing.generated_by} /></h3>
          <p style={{ whiteSpace: "pre-wrap" }}>{listing.description}</p>
          <table><tbody>{listing.item_specifics.map((s) => <tr key={s.name}><th>{s.name}</th><td>{s.value}</td></tr>)}</tbody></table>
          <p><strong>Suggested price:</strong> USD {listing.price.usd} <span className="badge warn">estimate</span><br /><span className="muted">{listing.price.note}</span></p>
          <p><strong>Customs description:</strong> {listing.customs_description}</p>
          <p><strong>HS code candidate:</strong> {listing.hs_code.candidate || "(none)"} <span className="badge warn">{listing.hs_code.label}</span></p>

          <h3>Bill a buyer with PayPal ({health.paymentPath === "invoice" ? "invoice" : "payment link"})</h3>
          <div className="row">
            <div>
              <label>Buyer (PayPal sandbox demo buyer)</label>
              <select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
                {health.demo.buyers.length === 0 && <option value="">No demo buyers configured (DEMO_BUYER_EMAILS)</option>}
                {health.demo.buyers.map((b) => <option key={b.alias} value={b.alias}>{b.alias} ({b.email})</option>)}
              </select>
            </div>
            <div>
              <label>Currency (PayPal code; JPY, HUF, TWD: whole numbers only)</label>
              <input value={price.currency_code} maxLength={3} onChange={(e) => setPrice({ ...price, currency_code: e.target.value.toUpperCase() })} />
            </div>
            <div>
              <label>Amount</label>
              <input value={price.value} onChange={(e) => setPrice({ ...price, value: e.target.value })} />
            </div>
          </div>
          <button className="primary" disabled={prepare.busy || !buyer} onClick={() => void prepare.run()}>
            {prepare.busy ? "Preparing…" : health.paymentPath === "invoice" ? "Prepare invoice for approval" : "Prepare payment link for approval"}
          </button>
          <ErrorBox error={prepare.error} />
        </div>
      )}

      {prepared && (
        <ProposalCard proposal={prepared.proposal} onChange={onProposal}>
          <p className="ai-note muted">Message to buyer <AiBadge by={prepared.generated_by} />: <em>{prepared.buyer_message.subject}</em> — {prepared.buyer_message.note}</p>
        </ProposalCard>
      )}
    </section>
  );
}
