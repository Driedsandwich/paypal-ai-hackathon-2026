import { afterEach, describe, expect, it } from "vitest";
import { loadSettings } from "../src/config.js";
import { byCountry, insightCards, insightRows, ledgerTracks, studioFrameHeight, type InsightJourney } from "../web/src/insights-data.js";
import { startApp } from "./helpers/http.js";

// Pass 4, item 4: the "Disputes (sum)" column of Insights' by-country table, and the totals.

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("Insights data", () => {
  it("by-country sums (revenue, unpaid, disputes) add up to the cards, on the offline demo's sales", async () => {
    const app = await startApp({ settings: loadSettings({ PAYPAL_OFFLINE_DEMO: "true" }) });
    close = app.close;
    // A dispute on a paid sale, as a judge would simulate it.
    let journeys: InsightJourney[] = (await app.get("/api/journeys")).body.data.journeys;
    const paid = (journeys as Array<InsightJourney & { can_simulate_dispute?: boolean }>).find((j) => j.can_simulate_dispute)!;
    expect((await app.post("/api/offline/simulate", { sale_id: paid.id, action: "dispute" })).status).toBe(200);
    journeys = (await app.get("/api/journeys")).body.data.journeys;

    const rows = insightRows(journeys);
    const cards = insightCards(rows);
    const ledger = [...byCountry(rows).values()];
    expect(cards.disputed).toBeGreaterThanOrEqual(2); // the seeded dispute and the new one
    expect(sum(ledger.map((c) => c.disputed))).toBe(cards.disputed);
    expect(sum(ledger.map((c) => c.revenue_usd))).toBeCloseTo(cards.revenue, 2);
    expect(sum(ledger.map((c) => c.unpaid_usd))).toBeCloseTo(cards.unpaid, 2);
    // Every disputed USD sale is counted once, in its own country.
    const disputedUsd = journeys.filter((j) => j.dispute && j.amount?.currency_code === "USD");
    expect(cards.disputed).toBe(disputedUsd.length);
    for (const j of disputedUsd) expect(byCountry(rows).get(j.country_name)!.disputed).toBeGreaterThanOrEqual(1);
  });

  it("counts disputes per row and leaves non-USD sales out of every total", () => {
    const base = { created_at: "2026-10-01T00:00:00Z", title_en: "Item" };
    const rows = insightRows([
      { ...base, id: "A", country_name: "Germany", stage: "shipped", amount: { currency_code: "USD", value: "120.00" }, dispute: { dispute_id: "PP-D-1" } },
      { ...base, id: "B", country_name: "Germany", stage: "invoiced", amount: { currency_code: "USD", value: "40.50" } },
      { ...base, id: "C", country_name: "Canada", stage: "paid", amount: { currency_code: "USD", value: "80.00" } },
      { ...base, id: "D", country_name: "France", stage: "paid", amount: { currency_code: "EUR", value: "90.00" }, dispute: { dispute_id: "PP-D-2" } },
    ]);
    expect(insightCards(rows)).toEqual({ revenue: 200, unpaid: 40.5, disputed: 1, paid: 2 });
    expect(Object.fromEntries(byCountry(rows))).toEqual({
      Germany: { revenue_usd: 120, unpaid_usd: 40.5, disputed: 1 },
      Canada: { revenue_usd: 80, unpaid_usd: 0, disputed: 0 },
    });
  });

  it("gives the ledger room for every country, so no scrollbar covers the Disputes column", () => {
    expect(ledgerTracks(1)).toBe(15);
    expect(ledgerTracks(6)).toBe(18);
    expect(ledgerTracks(10)).toBeGreaterThan(ledgerTracks(6));
    expect(studioFrameHeight(15)).toBe(620);
    expect(studioFrameHeight(ledgerTracks(6))).toBeGreaterThan(620);
  });
});
