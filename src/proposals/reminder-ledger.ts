/**
 * PayPal: "API caller can send only 2 reminders in a day" (Send invoice reminder). The app
 * enforces at most 2 reminders per invoice per UTC day. In memory: reminders sent outside this
 * app (or before a restart) are not counted, and PayPal remains the final judge.
 */
export const REMINDERS_PER_INVOICE_PER_DAY = 2;
const MAX_TRACKED_INVOICES = 10_000;

export class ReminderLedger {
  private day = "";
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly perDay = REMINDERS_PER_INVOICE_PER_DAY,
    private readonly now: () => number = Date.now,
  ) {}

  private rollover(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  remaining(invoiceId: string): number {
    this.rollover();
    return Math.max(0, this.perDay - (this.counts.get(invoiceId) ?? 0));
  }

  /** Counts one reminder if one is left today. */
  reserve(invoiceId: string): boolean {
    if (this.remaining(invoiceId) <= 0) return false;
    if (!this.counts.has(invoiceId) && this.counts.size >= MAX_TRACKED_INVOICES) return false;
    this.counts.set(invoiceId, (this.counts.get(invoiceId) ?? 0) + 1);
    return true;
  }

  /** Gives a reservation back (PayPal definitely refused the reminder). */
  release(invoiceId: string): void {
    this.rollover();
    const n = this.counts.get(invoiceId) ?? 0;
    if (n <= 1) this.counts.delete(invoiceId);
    else this.counts.set(invoiceId, n - 1);
  }
}
