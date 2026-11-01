// Email masking for everything the public API returns (F3): "m***@example.com".

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** Replaces every email address in a text with its masked form. */
export function maskEmailsInText(text: string): string {
  return text.replace(EMAIL, (m) => maskEmail(m));
}

/** Deep copy of a JSON-like value with every email address in every string masked. */
export function maskEmailsDeep<T>(value: T): T {
  return walk(value, 0) as T;
}

function walk(value: unknown, depth: number): unknown {
  if (depth > 40) return value;
  if (typeof value === "string") return value.includes("@") ? maskEmailsInText(value) : value;
  if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, depth + 1);
    return out;
  }
  return value;
}
