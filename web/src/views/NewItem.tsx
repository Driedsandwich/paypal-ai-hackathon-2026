import { useEffect, useState } from "react";
import { api, money, type GeneratedBy } from "../api";
import { go, type ViewProps } from "../App";
import { ErrorBox, Icon, ModelChip, useAction } from "../components";

interface JpItem {
  title_ja: string;
  description_ja: string;
  price_jpy: number;
  condition?: string;
  category?: string;
  weight_g?: number;
}
interface Listing {
  sale_id: string;
  title: string;
  description: string;
  item_specifics: Array<{ name: string; value: string }>;
  customs_description: string;
  price: { jpy: number; usd: string; fx_jpy_per_usd: number; note: string };
  hs_code: { candidate: string; label: string };
  generated_by: GeneratedBy;
}

const EMPTY: JpItem = { title_ja: "", description_ja: "", price_jpy: 0 };

export function NewItemView({ health, refresh }: ViewProps) {
  const [samples, setSamples] = useState<Array<{ key: string; item: JpItem }>>([]);
  const [item, setItem] = useState<JpItem>(EMPTY);
  const [country, setCountry] = useState("US");
  const [listing, setListing] = useState<Listing | null>(null);
  const [buyer, setBuyer] = useState(health.demo.buyers[0]?.alias ?? "");
  const [price, setPrice] = useState({ currency_code: "USD", value: "" });

  useEffect(() => {
    api.get<Array<{ key: string; item: JpItem }>>("/api/demo/items").then(setSamples, () => setSamples([]));
  }, []);

  const draft = useAction(async () => {
    const clean = { ...item, ...(item.weight_g ? {} : { weight_g: undefined }), ...(item.category ? {} : { category: undefined }) };
    const l = await api.post<Listing>("/api/listings/draft", { item: clean, country });
    setListing(l);
    setPrice({ currency_code: "USD", value: l.price.usd });
    await refresh();
  });
  const prepare = useAction(async () => {
    if (!listing) return;
    const path = health.paymentPath === "order" ? "/api/payment-links/prepare" : "/api/invoices/prepare";
    const res = await api.post<{ sale_id: string }>(path, {
      sale_id: listing.sale_id,
      country,
      title_ja: item.title_ja,
      listing: { title: listing.title.slice(0, 127), description: listing.description.slice(0, 1000), price, quantity: 1 },
      buyer: { alias: buyer },
    });
    await refresh();
    go({ view: "journeys", arg: res.sale_id });
  });

  return (
    <div className="form-page">
      <header className="page-head">
        <h1 className="serif">New item</h1>
        <p className="muted">Type it in Japanese. {health.ai.provider === "fake" ? "The offline AI" : "The AI"} drafts the English listing; the app converts the price at {health.fxJpyPerUsd} JPY/USD as an estimate.</p>
      </header>

      {samples.length > 0 && (
        <div className="samples" role="group" aria-label="Sample items">
          <span className="muted">Samples:</span>
          {samples.map((s) => (
            <button key={s.key} className="btn btn-ghost btn-small jp" onClick={() => { setItem({ ...EMPTY, ...s.item }); setListing(null); }}>
              {s.item.title_ja}
            </button>
          ))}
        </div>
      )}

      <section className="sheet" aria-label="Item in Japanese">
        <label className="field">
          <span>商品名 Title (Japanese)</span>
          <input className="jp" value={item.title_ja} maxLength={200} onChange={(e) => setItem({ ...item, title_ja: e.target.value })} />
        </label>
        <label className="field">
          <span>説明 Description (Japanese)</span>
          <textarea className="jp" value={item.description_ja} maxLength={4000} onChange={(e) => setItem({ ...item, description_ja: e.target.value })} />
        </label>
        <div className="field-row">
          <label className="field">
            <span>価格 Price (JPY)</span>
            <input type="number" inputMode="numeric" min={1} value={item.price_jpy || ""} onChange={(e) => setItem({ ...item, price_jpy: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>状態 Condition</span>
            <select value={item.condition ?? ""} onChange={(e) => setItem({ ...item, ...(e.target.value ? { condition: e.target.value } : { condition: undefined }) })}>
              <option value="">—</option>
              <option value="new">New</option>
              <option value="handmade">Handmade</option>
              <option value="used_like_new">Used, like new</option>
              <option value="used_good">Used, good</option>
              <option value="used_fair">Used, fair</option>
            </select>
          </label>
          <label className="field">
            <span>重さ Weight (g)</span>
            <input type="number" inputMode="numeric" min={1} value={item.weight_g ?? ""} onChange={(e) => setItem({ ...item, ...(e.target.value ? { weight_g: Number(e.target.value) } : { weight_g: undefined }) })} />
          </label>
          <label className="field">
            <span>Buyer country</span>
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              {health.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="decision">
          <button className="btn btn-primary" disabled={draft.busy || !item.title_ja.trim() || !item.price_jpy} onClick={() => void draft.run()}>
            {draft.busy ? "Drafting…" : "Draft English listing with AI"}
          </button>
        </div>
        <ErrorBox error={draft.error} />
      </section>

      {listing && (
        <section className="sheet" aria-label="English listing">
          <p className="ledger-cap">English listing · {listing.sale_id} <ModelChip by={listing.generated_by} /></p>
          <h2 className="serif">{listing.title}</h2>
          <p className="pre">{listing.description}</p>
          <div className="ledger">
            {listing.item_specifics.map((s) => (
              <div className="ledger-row" key={s.name}><span>{s.name}</span><span>{s.value}</span></div>
            ))}
            <div className="ledger-row"><span>Customs description</span><span>{listing.customs_description}</span></div>
            <div className="ledger-row">
              <span>HS code candidate</span>
              <span>
                {listing.hs_code.candidate || "(none)"} <span className="tag tag-warn"><Icon name="alert" size={14} /> {listing.hs_code.label}</span>
              </span>
            </div>
            <div className="ledger-row total">
              <span>Suggested price <span className="tag tag-warn">estimate</span></span>
              <span className="num serif">{money({ currency_code: "USD", value: listing.price.usd })}</span>
            </div>
          </div>
          <p className="muted small">{listing.price.note}</p>

          <h3 className="h3">Bill the buyer with PayPal ({health.paymentPath === "invoice" ? "invoice" : "payment link"})</h3>
          <div className="field-row">
            <label className="field">
              <span>Buyer (sandbox demo buyer)</span>
              <select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
                {health.demo.buyers.length === 0 && <option value="">No demo buyers configured (DEMO_BUYER_EMAILS)</option>}
                {health.demo.buyers.map((b) => <option key={b.alias} value={b.alias}>{b.alias}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Currency (JPY, HUF, TWD: whole numbers)</span>
              <input value={price.currency_code} maxLength={3} onChange={(e) => setPrice({ ...price, currency_code: e.target.value.toUpperCase() })} />
            </label>
            <label className="field">
              <span>Amount</span>
              <input value={price.value} inputMode="decimal" onChange={(e) => setPrice({ ...price, value: e.target.value })} />
            </label>
          </div>
          <div className="decision">
            <a className="btn btn-outline" href={`#journeys/${listing.sale_id}`}>Keep as draft</a>
            <button className="btn btn-primary" disabled={prepare.busy || !buyer} onClick={() => void prepare.run()}>
              {prepare.busy ? "Preparing…" : health.paymentPath === "invoice" ? "Prepare invoice for approval" : "Prepare payment link for approval"}
            </button>
          </div>
          <ErrorBox error={prepare.error} />
        </section>
      )}
    </div>
  );
}
