import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ListingForSaleSchema, SellerMoneySchema } from "../src/agent/schemas.js";
import { buildInvoicePayload, buildOrderPayload } from "../src/agent/tasks.js";
import { agentTools } from "../src/agent/tools.js";
import { decimalsFor, formatMinor, MoneyError, moneyProblem, multiplyMinor, normalizeAmount, showMoney, toMinor, usdFromJpy } from "../src/money.js";
import { ProposalStore } from "../src/proposals/store.js";
import { fakeEmail } from "./helpers/fake-fetch.js";

describe("money helpers", () => {
  it("knows which PayPal currencies have no decimals", () => {
    expect(["JPY", "HUF", "TWD", "USD", "EUR"].map(decimalsFor)).toEqual([0, 0, 0, 2, 2]);
  });

  it("parses into integer minor units and formats per currency", () => {
    expect(toMinor("80", "USD")).toBe(8000);
    expect(toMinor("80.5", "USD")).toBe(8050);
    expect(toMinor("0.07", "USD")).toBe(7);
    expect(toMinor("12000", "JPY")).toBe(12000);
    expect(formatMinor(8050, "USD")).toBe("80.50");
    expect(formatMinor(7, "EUR")).toBe("0.07");
    expect(formatMinor(12000, "JPY")).toBe("12000");
    expect(normalizeAmount("80", "USD")).toBe("80.00");
    // 0.1 + 0.2 style float errors cannot happen: 3 x 0.10 is exactly 0.30
    expect(formatMinor(multiplyMinor(toMinor("0.10", "USD"), 3), "USD")).toBe("0.30");
  });

  it("rejects invalid amounts with a clear reason", () => {
    expect(moneyProblem("100.50", "JPY")).toEqual({ field: "value", message: "JPY has no decimals: use a whole number such as 12000" });
    expect(moneyProblem("100.00", "HUF")?.field).toBe("value");
    expect(moneyProblem("1.999", "USD")?.message).toMatch(/at most 2 decimals/);
    expect(moneyProblem("0", "USD")?.message).toMatch(/greater than zero/);
    expect(moneyProblem("0.00", "EUR")?.message).toMatch(/greater than zero/);
    expect(moneyProblem("-5", "USD")).toBeDefined();
    expect(moneyProblem("1e3", "USD")).toBeDefined();
    expect(moneyProblem("10", "XYZ")).toMatchObject({ field: "currency_code", message: expect.stringMatching(/not a PayPal currency/) });
    expect(moneyProblem("10", "usd")?.field).toBe("currency_code");
    expect(() => toMinor("1.5", "TWD")).toThrow(MoneyError);
  });

  it("estimates USD from JPY in cents, rounded half up", () => {
    expect(usdFromJpy(12000, 150)).toBe("80.00");
    expect(usdFromJpy(10000, 157.3)).toBe("63.57");
    expect(usdFromJpy(1, 150)).toBe("0.01");
    expect(showMoney({ currency_code: "JPY", value: "12000" })).toBe("JPY 12000");
    expect(showMoney({ currency_code: "USD", value: "80" })).toBe("USD 80.00");
  });
});

describe("seller prices are validated before any proposal exists", () => {
  it("SellerMoneySchema points at the wrong field", () => {
    const bad = SellerMoneySchema.safeParse({ currency_code: "JPY", value: "100.50" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ["value"], message: expect.stringMatching(/no decimals/) });
    expect(SellerMoneySchema.safeParse({ currency_code: "ABC", value: "1" }).error?.issues[0]?.path).toEqual(["currency_code"]);
    expect(ListingForSaleSchema.safeParse({ title: "Tea bowl", price: { currency_code: "JPY", value: "12000" } }).success).toBe(true);
  });

  it("order and invoice payloads use the currency's precision", () => {
    const jpy = buildOrderPayload({ title: "Tea bowl", description: "", price: { currency_code: "JPY", value: "12000" }, quantity: 2 }, { publicBaseUrl: "https://demo.invalid" });
    const unit = jpy.order.purchase_units[0]!;
    expect(unit.amount).toEqual({ currency_code: "JPY", value: "24000", breakdown: { item_total: { currency_code: "JPY", value: "24000" } } });
    expect(unit.items![0]!.unit_amount).toEqual({ currency_code: "JPY", value: "12000" });

    const usd = buildOrderPayload({ title: "Tea bowl", description: "", price: { currency_code: "USD", value: "19.99" }, quantity: 3 }, { publicBaseUrl: "https://demo.invalid" });
    expect(usd.order.purchase_units[0]!.amount.value).toBe("59.97");

    const inv = buildInvoicePayload({ title: "Tea bowl", description: "", price: { currency_code: "USD", value: "80" }, quantity: 1 }, { email: fakeEmail("b") }, { subject: "s", note: "n" });
    expect(inv.invoice.items[0]!.unit_amount).toEqual({ currency_code: "USD", value: "80.00" });
    expect(() => buildOrderPayload({ title: "x", description: "", price: { currency_code: "JPY", value: "100.50" }, quantity: 1 }, { publicBaseUrl: "https://demo.invalid" })).toThrow(MoneyError);
  });

  it("chat sale tools validate the price and still have a JSON schema for the model", () => {
    const tools = agentTools({ paypal: undefined, proposals: new ProposalStore(async () => undefined), agentConfig: { fxJpyPerUsd: 150, maxOutputTokens: 500, publicBaseUrl: "https://demo.invalid" }, paymentPath: "order" });
    const createOrder = tools.find((t) => t.name === "create_order")!;
    expect(() => createOrder.inputSchema.parse({ item_title: "Tea bowl", price: { currency_code: "JPY", value: "100.50" }, subject: "Payment", note: "Thanks for your order!" })).toThrow();
    const json = z.toJSONSchema(createOrder.inputSchema, { io: "input" }) as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(json.properties.price!.properties!)).toEqual(["currency_code", "value"]);
  });
});
