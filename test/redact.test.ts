import { describe, expect, it } from "vitest";
import { redactDeep, redactPersonalData } from "../src/privacy/redact.js";
import { fakeEmail } from "./helpers/fake-fetch.js";

describe("redactPersonalData (F7)", () => {
  it("removes email addresses", () => {
    expect(redactPersonalData(`Contact me at ${fakeEmail("buyer.name")} please`)).toBe("Contact me at [email removed] please");
  });

  it("removes phone numbers in common formats", () => {
    const cases = [
      "Call +81 90-1234-5678 anytime",
      "Call +1 (555) 123-4567 anytime",
      "Call 090-1234-5678 anytime",
      "Call 03-1234-5678 anytime",
      "Call (03) 1234-5678 anytime",
      "Call 09012345678 anytime",
      "Call (555) 123-4567 anytime",
      "Call 555-123-4567 anytime",
      "Call ０９０－１２３４－５６７８ anytime",
      "Call phone: 5551234567 anytime",
      "Call 電話番号：0312345678 anytime",
    ];
    for (const c of cases) expect(redactPersonalData(c), c).toMatch(/^Call (phone: |電話番号：)?\[phone removed\] anytime$/);
  });

  it("removes street-address-like lines", () => {
    const text = ["Hi, please ship to:", "123 Main Street, Apt 4B", "Springfield, IL 62704", "〒100-0001 東京都千代田区千代田1-1", "Thanks!"].join("\n");
    expect(redactPersonalData(text)).toBe(["Hi, please ship to:", "[address removed]", "[address removed]", "[address removed]", "Thanks!"].join("\n"));
    expect(redactPersonalData("東京都渋谷区神南1丁目2-3 に送ってください")).toBe("[address removed]");
    expect(redactPersonalData("Flat 2, 10 Downing Street, London SW1A 2AA")).toBe("[address removed]");
  });

  it("keeps tracking numbers, ids, dates, amounts and ordinary text", () => {
    const keep = [
      "Tracking EJ123456789JP was shipped on 2026-10-17.",
      "Yamato tracking 1234-5678-9012, invoice 0001, paid 80.00 USD.",
      "Dispute PP-D-1234 for transaction 8MC585209K746392H.",
      "Order 5O190127TN364715T at 2026-10-28T03:00:00Z.",
      "The tea bowl is 12 cm wide and 8 cm tall. 2 items.",
      "手作りの抹茶碗です。直径12cm、高さ8cm。",
      "Where is my item? I waited 14 days.",
    ];
    for (const t of keep) expect(redactPersonalData(t), t).toBe(t);
  });

  it("redactDeep leaves structured fields alone", () => {
    const input = { tracking: { carrier: "Yamato", tracking_number: "090-1234-5678" }, messages: [{ content: "Call 090-1234-5678" }], seller_notes: `mail ${fakeEmail("x")}` };
    expect(redactDeep(input)).toEqual({ tracking: { carrier: "Yamato", tracking_number: "090-1234-5678" }, messages: [{ content: "Call [phone removed]" }], seller_notes: "mail [email removed]" });
  });
});
