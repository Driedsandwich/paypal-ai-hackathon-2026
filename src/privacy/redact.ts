// Pattern-based redaction of personal contact data in free text before it is sent to the AI
// model (F7): email addresses, phone numbers and street-address-like lines. It is a best-effort
// filter, not a guarantee: names and unusual formats are not detected. Patterns are kept
// conservative so tracking numbers (e.g. 1234-5678-9012, EJ123456789JP), dates and amounts
// survive.

export const EMAIL_PLACEHOLDER = "[email removed]";
export const PHONE_PLACEHOLDER = "[phone removed]";
export const ADDRESS_PLACEHOLDER = "[address removed]";

const D = "[0-9０-９]"; // ASCII and full-width digits
const SEP = "[\\s.\\-‐‑–－ー]"; // separators, incl. full-width hyphen and the long vowel mark often typed for it

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** Phone candidates; each match is kept only if its digit count fits the pattern. */
const PHONES: Array<{ re: RegExp; min: number; max: number }> = [
  // International: +81 90 1234 5678, +1 (555) 123-4567
  { re: new RegExp(`[+＋]${D}{1,3}${SEP}?(?:\\(?${D}{1,4}\\)?${SEP}?){1,5}${D}{2,4}`, "g"), min: 8, max: 15 },
  // Japan, with separators: 090-1234-5678, 03-1234-5678, 0120-123-456
  { re: new RegExp(`(?<![0-9０-９])[0０]${D}{1,4}${SEP}${D}{1,4}${SEP}${D}{3,4}(?![0-9０-９])`, "g"), min: 10, max: 11 },
  // Japan, (03) 1234-5678
  { re: new RegExp(`\\([0０]${D}{1,4}\\)${SEP}?${D}{1,4}${SEP}${D}{4}`, "g"), min: 10, max: 11 },
  // Japan mobile without separators: 09012345678
  { re: new RegExp(`(?<![0-9０-９])[0０][7-9７-９][0０]${D}{8}(?![0-9０-９])`, "g"), min: 11, max: 11 },
  // North America: (555) 123-4567, 555-123-4567, 555.123.4567
  { re: new RegExp(`\\(${D}{3}\\)${SEP}?${D}{3}${SEP}${D}{4}`, "g"), min: 10, max: 10 },
  { re: new RegExp(`(?<![0-9０-９])${D}{3}[.\\-]${D}{3}[.\\-]${D}{4}(?![0-9０-９])`, "g"), min: 10, max: 10 },
];

/** "phone: 5551234567", "TEL 0312345678", "電話番号：...": the number after a phone keyword. */
const PHONE_KEYWORD = new RegExp(`((?:phone|tel|telephone|mobile|cell|whatsapp|電話|携帯)(?:\\s*(?:number|no\\.?|番号))?\\s*[:：]?\\s*)([+＋]?[0-9０-９][0-9０-９\\s().\\-‐－ー]{6,20}[0-9０-９])`, "gi");

const ADDRESS_LINE: RegExp[] = [
  // 123 Main Street, 42B Baker St., 10 Downing Street
  /\b\d{1,6}[A-Za-z]?,?\s+(?:[A-Za-z0-9.'-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|way|court|ct|place|pl|terrace|parkway|pkwy|highway|hwy|circle|cir|square|sq)\b\.?/i,
  /\b(?:apt|apartment|suite|ste|unit|flat)\.?\s*#?\s*\d+[A-Za-z]?\b/i,
  /\bp\.?\s?o\.?\s*box\s*\d+/i,
  /\b[A-Z][a-z]+,?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/, // Springfield, IL 62704
  /\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b/, // UK postcode: SW1A 1AA
  /〒\s*[0-9０-９]{3}[-－‐]?[0-9０-９]{4}/,
  /(?:都|道|府|県).{0,15}?(?:市|区|郡|町|村).{0,25}?[0-9０-９]+\s*(?:丁目|番地|番|号|[-－‐]\s*[0-9０-９]+)/,
];

function digits(s: string): number {
  return (s.match(/[0-9０-９]/g) ?? []).length;
}

/** Replaces email addresses, phone numbers and street-address-like lines in a text. */
export function redactPersonalData(text: string): string {
  if (!text) return text;
  let out = text.replace(EMAIL, EMAIL_PLACEHOLDER);
  out = out.replace(PHONE_KEYWORD, (_m, lead: string, num: string) => (digits(num) >= 7 ? `${lead}${PHONE_PLACEHOLDER}` : `${lead}${num}`));
  for (const { re, min, max } of PHONES) {
    out = out.replace(re, (m) => {
      const n = digits(m);
      return n >= min && n <= max ? PHONE_PLACEHOLDER : m;
    });
  }
  return out
    .split(/(\r?\n)/)
    .map((line) => (ADDRESS_LINE.some((re) => re.test(line)) ? ADDRESS_PLACEHOLDER : line))
    .join("");
}

/** Keys whose values are structured facts, not free text (left untouched). */
export const STRUCTURED_KEYS: ReadonlySet<string> = new Set(["tracking_number", "tracking_url", "carrier", "invoice_id", "invoice_number", "dispute_id", "transaction_id", "currency_code", "value"]);

/** Deep copy of a JSON-like value with every free-text string redacted. */
export function redactDeep<T>(value: T, skipKeys: ReadonlySet<string> = STRUCTURED_KEYS, depth = 0): T {
  if (depth > 40) return value;
  if (typeof value === "string") return redactPersonalData(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, skipKeys, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = skipKeys.has(k) ? v : redactDeep(v, skipKeys, depth + 1);
    return out as T;
  }
  return value;
}
