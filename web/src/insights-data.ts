// Pure data for the Insights view (no React, no AG Studio), so it can be unit-tested.
// Self-contained types: the server's test build resolves modules differently from Vite.

/** The fields of a journey that Insights reads (a subset of `Journey` in ./api). */
export interface InsightJourney {
  id: string;
  country_name: string;
  amount?: { currency_code: string; value: string };
  stage: string;
  created_at: string;
  dispute?: unknown;
  invoice_number?: string;
  title_en: string;
}

export interface InsightRow {
  sale: string;
  country: string;
  revenue_usd: number;
  unpaid_usd: number;
  days_outstanding: number;
  disputed: number;
  paid: number;
  invoice: string;
  item: string;
}

/** One row per USD sale (other currencies are left out of the USD totals). */
export function insightRows(journeys: InsightJourney[], now = Date.now()): InsightRow[] {
  return journeys
    .filter((j) => j.amount?.currency_code === "USD")
    .map((j) => {
      const paid = j.stage === "paid" || j.stage === "shipped" || j.stage === "delivered";
      const billed = j.stage !== "draft";
      const value = Number(j.amount!.value);
      return {
        sale: j.id,
        country: j.country_name,
        revenue_usd: paid ? value : 0,
        unpaid_usd: billed && !paid ? value : 0,
        days_outstanding: billed && !paid ? Math.max(0, Math.floor((now - Date.parse(j.created_at)) / 86_400_000)) : 0,
        disputed: j.dispute ? 1 : 0,
        paid: paid ? 1 : 0,
        invoice: j.invoice_number ?? j.id,
        item: j.title_en,
      };
    });
}

/** The summary cards above the dashboard (paid revenue, unpaid, dispute rate). */
export function insightCards(rows: InsightRow[]): { revenue: number; unpaid: number; disputed: number; paid: number } {
  return {
    revenue: rows.reduce((n, r) => n + r.revenue_usd, 0),
    unpaid: rows.reduce((n, r) => n + r.unpaid_usd, 0),
    disputed: rows.reduce((n, r) => n + r.disputed, 0),
    paid: rows.reduce((n, r) => n + r.paid, 0),
  };
}

/** The "By country" ledger as AG Studio sums it: revenue, unpaid and disputes per country. */
export function byCountry(rows: InsightRow[]): Map<string, { revenue_usd: number; unpaid_usd: number; disputed: number }> {
  const out = new Map<string, { revenue_usd: number; unpaid_usd: number; disputed: number }>();
  for (const r of rows) {
    const c = out.get(r.country) ?? { revenue_usd: 0, unpaid_usd: 0, disputed: 0 };
    c.revenue_usd += r.revenue_usd;
    c.unpaid_usd += r.unpaid_usd;
    c.disputed += r.disputed;
    out.set(r.country, c);
  }
  return out;
}

/**
 * Layout tracks for the "By country" grid: title, header, one row per country and the total
 * row, without a vertical scrollbar. A scrollbar sits over the last column and hid the
 * right-aligned "Disputes (sum)" numbers (pass 4: that column looked empty).
 */
export function ledgerTracks(countries: number): number {
  return Math.max(15, 8 + Math.ceil(countries * 1.6));
}

/** Frame height in px for a ledger of `tracks` (the default layout is 620 px with 15 tracks). */
export function studioFrameHeight(tracks: number): number {
  return 620 + (tracks - 15) * 16;
}
