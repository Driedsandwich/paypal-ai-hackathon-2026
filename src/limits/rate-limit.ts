/**
 * Cost and abuse limits for AI routes (spec 3.2):
 * - per-IP sliding window (default 20 calls per 10 minutes)
 * - global daily cap (default 300 calls per UTC day)
 */
export interface AiLimitConfig {
  perIpMax: number;
  windowMs: number;
  dailyCap: number;
}

export type LimitResult =
  | { ok: true; remainingToday: number }
  | { ok: false; reason: "per_ip" | "daily_cap"; retryAfterSeconds: number; message: string };

export class AiLimiter {
  private readonly hits = new Map<string, number[]>();
  private day = "";
  private usedToday = 0;

  constructor(
    readonly config: AiLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Checks and, if allowed, counts one AI call for this client. */
  take(clientKey: string): LimitResult {
    const t = this.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.usedToday = 0;
    }
    if (this.usedToday >= this.config.dailyCap) {
      const nextDay = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
      return {
        ok: false,
        reason: "daily_cap",
        retryAfterSeconds: Math.max(1, Math.ceil((nextDay - t) / 1000)),
        message: `The demo's daily AI limit (${this.config.dailyCap} calls) has been reached. It resets at 00:00 UTC.`,
      };
    }
    const since = t - this.config.windowMs;
    const recent = (this.hits.get(clientKey) ?? []).filter((x) => x > since);
    if (recent.length >= this.config.perIpMax) {
      this.hits.set(clientKey, recent);
      return {
        ok: false,
        reason: "per_ip",
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + this.config.windowMs - t) / 1000)),
        message: `Too many AI requests from your address (limit ${this.config.perIpMax} per ${Math.round(
          this.config.windowMs / 60_000,
        )} minutes). Please wait a little and try again.`,
      };
    }
    recent.push(t);
    this.hits.set(clientKey, recent);
    this.usedToday += 1;
    if (this.hits.size > 10_000) this.prune(since);
    return { ok: true, remainingToday: this.config.dailyCap - this.usedToday };
  }

  usage(): { day: string; usedToday: number; dailyCap: number } {
    return { day: this.day, usedToday: this.usedToday, dailyCap: this.config.dailyCap };
  }

  private prune(since: number): void {
    for (const [k, v] of this.hits) if (!v.some((x) => x > since)) this.hits.delete(k);
  }
}
