import { maskEmail } from "../privacy/mask.js";

/** A sandbox buyer from DEMO_BUYER_EMAILS, shown publicly only by alias ("Demo buyer 1"). */
export interface DemoBuyer {
  alias: string;
  email: string;
}

/**
 * The only recipients invoices and payment links may go to on this public demo. Aliases are
 * resolved to email addresses on the server, right before the PayPal call.
 */
export class DemoBuyers {
  private readonly buyers: DemoBuyer[];

  constructor(emails: string[]) {
    const seen = new Set<string>();
    this.buyers = [];
    for (const e of emails) {
      const email = e.trim();
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      this.buyers.push({ alias: `Demo buyer ${this.buyers.length + 1}`, email });
    }
  }

  get aliases(): string[] {
    return this.buyers.map((b) => b.alias);
  }

  get size(): number {
    return this.buyers.length;
  }

  /** Resolves "Demo buyer 1" (case and spacing do not matter). */
  resolve(alias: string): DemoBuyer | undefined {
    const key = alias.trim().replace(/\s+/g, " ").toLowerCase();
    return this.buyers.find((b) => b.alias.toLowerCase() === key);
  }

  isAllowed(email: string): boolean {
    return this.buyers.some((b) => b.email.toLowerCase() === email.trim().toLowerCase());
  }

  aliasOf(email: string): string | undefined {
    return this.buyers.find((b) => b.email.toLowerCase() === email.trim().toLowerCase())?.alias;
  }

  /** Round-robin pick, for seeding. */
  at(index: number): DemoBuyer {
    if (this.buyers.length === 0) throw new Error("no demo buyers configured");
    return this.buyers[index % this.buyers.length]!;
  }

  /** What the public may see: alias and masked email. */
  publicList(): Array<{ alias: string; email: string }> {
    return this.buyers.map((b) => ({ alias: b.alias, email: maskEmail(b.email) }));
  }
}
