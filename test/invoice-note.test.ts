import { describe, expect, it } from "vitest";
import { FakeAiProvider } from "../src/ai/index.js";
import { ListingForSaleSchema, listingTotals } from "../src/agent/schemas.js";
import { Agent, amountsIn, noteMatchingTotal, type AgentConfig } from "../src/agent/tasks.js";

// Pass 5, item 3: item 80.00 USD + shipping 15.00 USD; the AI note said "The price is 80.00 USD"
// while the invoice total was 95.00 USD.
const CONFIG: AgentConfig = { fxJpyPerUsd: 150, maxOutputTokens: 800, sellerBusinessName: "Okuri Demo Shop", publicBaseUrl: "http://localhost:3000/" };
const LISTING = ListingForSaleSchema.parse({ title: "Handmade tea bowl", price: { currency_code: "USD", value: "80.00" }, shipping: { currency_code: "USD", value: "15.00" } });
const note = (text: string) => new FakeAiProvider([JSON.stringify({ note: text })], { record: true });

/** True when every amount in the note is one PayPal bills, and the total is named whenever any amount is. */
function consistentWithTotal(text: string, total: string, allowed: string[]): boolean {
  const found = amountsIn(text);
  const ok = new Set(allowed.map((v) => Math.round(Number(v) * 100)));
  return found.length === 0 || (found.every((a) => ok.has(a)) && found.includes(Math.round(Number(total) * 100)));
}

describe("invoice note and shipping", () => {
  it("gives the note writer the item price, the shipping and the total", async () => {
    const ai = note("Thank you for your order! You can pay securely with PayPal.");
    await new Agent(ai, CONFIG).prepareInvoice(LISTING, { alias: "Demo buyer 1" });
    const user = ai.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain('"item_price":{"currency_code":"USD","value":"80.00"},"shipping":{"currency_code":"USD","value":"15.00"},"total":{"currency_code":"USD","value":"95.00"}');
    expect(ai.calls[0]!.messages[0]!.content).toMatch(/the buyer pays the total/);
  });

  it("a note that names the item price as the price gets the total; the note never contradicts the invoice total", async () => {
    const prepared = await new Agent(note("Hello! Thank you for buying the tea bowl. The price is 80.00 USD. You can pay securely with PayPal."), CONFIG).prepareInvoice(LISTING, { alias: "Demo buyer 1" });
    const text = prepared.payload.invoice.detail.note!;
    expect(text).toBe("Hello! Thank you for buying the tea bowl. The price is 80.00 USD. You can pay securely with PayPal. Total including shipping: 95.00 USD (item 80.00 USD + shipping 15.00 USD).");
    expect(prepared.buyer_message.note).toBe(text);
    expect(consistentWithTotal(text, "95.00", ["80.00", "15.00", "95.00"])).toBe(true);
    // PayPal's total is the item plus the shipping breakdown.
    expect(prepared.payload.invoice.amount?.breakdown?.shipping?.amount.value).toBe("15.00");
  });

  it("replaces a note with an amount PayPal does not bill, keeps a note that states the total or no amount", () => {
    const totals = listingTotals(LISTING);
    const wrong = noteMatchingTotal("The total is $90.00.", LISTING.title, totals);
    expect(wrong).toBe('Thank you for your order of "Handmade tea bowl". The total is 95.00 USD (item 80.00 USD + shipping 15.00 USD). You can pay securely with PayPal.');
    expect(consistentWithTotal(wrong, "95.00", ["80.00", "15.00", "95.00"])).toBe(true);
    expect(noteMatchingTotal("Item $80 plus shipping $15, total $95.00.", LISTING.title, totals)).toBe("Item $80 plus shipping $15, total $95.00.");
    expect(noteMatchingTotal("Thank you! Pay securely with PayPal.", LISTING.title, totals)).toBe("Thank you! Pay securely with PayPal.");
  });

  it("without shipping: the note is unchanged when it names the price, and the input is as before", async () => {
    const plain = ListingForSaleSchema.parse({ title: "Handmade tea bowl", price: { currency_code: "USD", value: "80.00" } });
    const ai = note("The price is 80.00 USD. Pay securely with PayPal.");
    const prepared = await new Agent(ai, CONFIG).prepareInvoice(plain, { alias: "Demo buyer 1" });
    expect(prepared.payload.invoice.detail.note).toBe("The price is 80.00 USD. Pay securely with PayPal.");
    expect(ai.calls[0]!.messages.find((m) => m.role === "user")!.content).toContain('"price":{"currency_code":"USD","value":"80.00"}');
    // Two of them: the unit price alone gets the total.
    const two = noteMatchingTotal("Each bowl is 80.00 USD.", plain.title, listingTotals({ ...plain, quantity: 2 }));
    expect(two).toBe("Each bowl is 80.00 USD. Total: 160.00 USD.");
  });

  it("reads amounts with signs, codes and grouping", () => {
    expect(amountsIn("US$80, 15.00 USD, JPY 12,000 and 3 bowls")).toEqual([8000, 1500, 1200000]);
  });
});
