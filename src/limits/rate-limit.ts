import { DailyCounter, SlidingWindowLimiter } from "./limits.js";

/**
 * Cost and abuse limits for AI routes (spec 3.2, F9):
 * - per-address allowance of valid AI requests (default 20 per 10 minutes), debited after the
 *   input has been validated;
 * - a separate cheap per-address limit on invalid AI requests (default 20 per window);
 * - a global daily budget of model calls (default 300 per UTC day): every model call counts,
 *   including each tool step of a chat and each repair retry of a JSON task.
 */
export interface AiLimitConfig {
  perIpMax: number;
  windowMs: number;
  dailyCap: number;
  /** Invalid AI requests per address per window before the address is refused. Default 20. */
  invalidMax?: number;
}

export type LimitResult =
  | { ok: true; remainingToday: number }
  | { ok: false; reason: "per_ip" | "daily_cap" | "invalid"; retryAfterSeconds: number; message: string };

/** The daily AI budget is used up (raised before a model call that would exceed it). */
export class AiBudgetError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "AiBudgetError";
  }
}

export class AiLimiter {
  private readonly perIp: SlidingWindowLimiter;
  private readonly invalid: SlidingWindowLimiter;
  private readonly budget: DailyCounter;

  constructor(
    readonly config: AiLimitConfig,
    now: () => number = Date.now,
  ) {
    this.perIp = new SlidingWindowLimiter(config.perIpMax, config.windowMs, now);
    this.invalid = new SlidingWindowLimiter(config.invalidMax ?? 20, config.windowMs, now);
    this.budget = new DailyCounter(config.dailyCap, now);
  }

  private minutes(): number {
    return Math.round(this.config.windowMs / 60_000);
  }

  private dailyCapResult(): LimitResult {
    return {
      ok: false,
      reason: "daily_cap",
      retryAfterSeconds: this.budget.secondsUntilReset(),
      message: `The demo's daily AI limit (${this.config.dailyCap} model calls) has been reached. It resets at 00:00 UTC.`,
    };
  }

  /** Cheap check before parsing: refuses addresses that sent too many invalid AI requests. */
  checkInvalid(clientKey: string): LimitResult {
    const wait = this.invalid.waitSeconds(clientKey);
    if (wait > 0) {
      return { ok: false, reason: "invalid", retryAfterSeconds: wait, message: `Too many invalid AI requests from your address. Please wait about ${Math.ceil(wait / 60)} minute(s).` };
    }
    return { ok: true, remainingToday: this.budget.remaining() };
  }

  recordInvalid(clientKey: string): void {
    this.invalid.record(clientKey);
  }

  /**
   * After validation: counts one AI request for this address and checks that the daily
   * budget has room for at least one model call. The model calls themselves are debited by
   * debitModelCall().
   */
  take(clientKey: string): LimitResult {
    if (this.budget.remaining() <= 0) return this.dailyCapResult();
    const wait = this.perIp.waitSeconds(clientKey);
    if (wait > 0) {
      return {
        ok: false,
        reason: "per_ip",
        retryAfterSeconds: wait,
        message: `Too many AI requests from your address (limit ${this.config.perIpMax} per ${this.minutes()} minutes). Please wait a little and try again.`,
      };
    }
    this.perIp.record(clientKey);
    return { ok: true, remainingToday: this.budget.remaining() };
  }

  /** Debits one model call; throws AiBudgetError when the daily budget is used up. */
  debitModelCall(): void {
    if (!this.budget.tryTake(1)) {
      const r = this.dailyCapResult();
      throw new AiBudgetError(r.ok ? "" : r.message, this.budget.secondsUntilReset());
    }
  }

  hasBudget(): boolean {
    return this.budget.remaining() > 0;
  }

  usage(): { usedToday: number; dailyCap: number } {
    return { usedToday: this.budget.used(), dailyCap: this.config.dailyCap };
  }
}
