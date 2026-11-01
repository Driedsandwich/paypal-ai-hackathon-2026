// Guardrail for dispute texts: the model must not state facts that are not in its inputs.
// We look for concrete, checkable tokens (dates, money amounts, tracking numbers and
// PayPal-style ids) in the generated text and flag any that do not appear in the inputs.

const PATTERNS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g, // ISO dates
  /\b\d{1,3}(?:,\d{3})*\.\d{2}\b|\b\d+\.\d{2}\b/g, // money amounts
  /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g, // UPU tracking numbers (Japan Post EMS etc.)
  /\b(?:PP-[A-Z0-9-]{4,}|INV2-[A-Z0-9-]{4,}|[A-Z0-9]{17})\b/g, // dispute, invoice, transaction ids
];

function normalize(s: string): string {
  return s.replace(/,/g, "");
}

/** Returns tokens in `text` that do not occur anywhere in `inputs` (stringified). */
export function unsupportedFacts(text: string, inputs: unknown): string[] {
  const haystack = normalize(JSON.stringify(inputs));
  const found = new Set<string>();
  for (const re of PATTERNS) {
    for (const m of text.matchAll(re)) {
      const token = m[0];
      if (!haystack.includes(normalize(token))) found.add(token);
    }
  }
  return [...found];
}
