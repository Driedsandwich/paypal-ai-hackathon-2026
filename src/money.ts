// Money helpers. Amounts are handled as integer minor units (cents; whole units for
// currencies without decimals) and formatted per currency, so no float rounding reaches
// PayPal. Currency list and decimal rules: PayPal's "Currency codes" reference
// (developer.paypal.com/api/rest/reference/currency-codes/): HUF, JPY and TWD "do not
// support decimals. If you pass a decimal amount, an error occurs."

export const PAYPAL_CURRENCIES = [
  "AUD", "BRL", "CAD", "CNY", "CZK", "DKK", "EUR", "HKD", "HUF", "ILS", "JPY", "MYR", "MXN",
  "TWD", "NZD", "NOK", "PHP", "PLN", "GBP", "RUB", "SGD", "SEK", "CHF", "THB", "USD",
] as const;

export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set(["HUF", "JPY", "TWD"]);

/** Largest integer part we accept for a unit price (PayPal allows up to 32 characters). */
const MAX_INTEGER_DIGITS = 10;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export function isSupportedCurrency(code: string): boolean {
  return (PAYPAL_CURRENCIES as readonly string[]).includes(code);
}

/** 0 for HUF, JPY and TWD; 2 for every other supported currency. */
export function decimalsFor(currency: string): 0 | 2 {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

/** Why this amount is not valid for the currency (and which field), or undefined when it is. */
export function moneyProblem(value: string, currency: string): { field: "currency_code" | "value"; message: string } | undefined {
  if (!isSupportedCurrency(currency)) {
    return { field: "currency_code", message: `${currency} is not a PayPal currency (supported: ${PAYPAL_CURRENCIES.join(", ")})` };
  }
  const decimals = decimalsFor(currency);
  const re = decimals === 0 ? new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}$`) : new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,2})?$`);
  if (!re.test(value)) {
    return {
      field: "value",
      message: decimals === 0 ? `${currency} has no decimals: use a whole number such as 12000` : "use an amount with at most 2 decimals, such as 80.00",
    };
  }
  if (toMinorUnchecked(value, decimals) <= 0) return { field: "value", message: "the amount must be greater than zero" };
  return undefined;
}

function toMinorUnchecked(value: string, decimals: 0 | 2): number {
  const [int, frac = ""] = value.split(".");
  return Number(int) * 10 ** decimals + (decimals === 0 ? 0 : Number(frac.padEnd(2, "0")));
}

/** Parses an amount string into integer minor units. Throws MoneyError when invalid. */
export function toMinor(value: string, currency: string): number {
  const problem = moneyProblem(value, currency);
  if (problem) throw new MoneyError(`Invalid ${currency} amount "${value}": ${problem.message}`);
  return toMinorUnchecked(value, decimalsFor(currency));
}

/** Formats integer minor units as PayPal expects for the currency ("80.00", "12000"). */
export function formatMinor(minor: number, currency: string): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new MoneyError(`amount out of range: ${minor}`);
  if (decimalsFor(currency) === 0) return String(minor);
  const s = String(minor).padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/** Re-formats a valid amount for its currency ("80" -> "80.00"). */
export function normalizeAmount(value: string, currency: string): string {
  return formatMinor(toMinor(value, currency), currency);
}

/** unit x quantity, in minor units, checked to stay a safe integer. */
export function multiplyMinor(unitMinor: number, quantity: number): number {
  const total = unitMinor * quantity;
  if (!Number.isSafeInteger(total) || !Number.isInteger(quantity) || quantity < 1) throw new MoneyError("total amount out of range");
  return total;
}

/** USD estimate from a JPY price at `jpyPerUsd`, rounded half up to the cent. */
export function usdFromJpy(priceJpy: number, jpyPerUsd: number): string {
  return formatMinor(Math.round((priceJpy * 100) / jpyPerUsd), "USD");
}

/** "USD 80.00" / "JPY 12000" for titles and messages. */
export function showMoney(m: { currency_code: string; value: string }): string {
  try {
    return `${m.currency_code} ${normalizeAmount(m.value, m.currency_code)}`;
  } catch {
    return `${m.currency_code} ${m.value}`;
  }
}
