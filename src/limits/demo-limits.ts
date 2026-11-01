import type { AppSettings } from "../config.js";
import type { ProposalKind } from "../proposals/store.js";
import { DailyCounter, LimitError, Semaphore, SlidingWindowLimiter } from "./limits.js";

/**
 * "Open a case by ID" lookups per session and per address per window (pass 3a), on top of the
 * PayPal read limit. Each lookup reads PayPal once and may add to the shared dispute registry.
 */
export const DISPUTE_LOOKUP_LIMIT = 10;

/**
 * Limits on everything that touches the shared PayPal sandbox account (F2), in addition to
 * the AI limits. All values come from env (see README), except DISPUTE_LOOKUP_LIMIT. In
 * memory, per process.
 */
export class DemoLimits {
  readonly windowMinutes: number;
  private readonly proposalsBySession: SlidingWindowLimiter;
  private readonly proposalsByAddress: SlidingWindowLimiter;
  private readonly approvalsBySession: SlidingWindowLimiter;
  private readonly approvalsByAddress: SlidingWindowLimiter;
  private readonly readsByAddress: SlidingWindowLimiter;
  private readonly lookupsBySession: SlidingWindowLimiter;
  private readonly lookupsByAddress: SlidingWindowLimiter;
  private readonly webhookByAddress: SlidingWindowLimiter;
  private readonly webhookGlobal: SlidingWindowLimiter;
  private readonly seedBySession: SlidingWindowLimiter;
  readonly seedsToday: DailyCounter;
  readonly writesToday: DailyCounter;
  /** At most this many approved actions execute at the same time. */
  readonly execution: Semaphore;

  constructor(settings: AppSettings, now: () => number = Date.now) {
    const windowMs = settings.rateLimitWindowMinutes * 60_000;
    this.windowMinutes = settings.rateLimitWindowMinutes;
    this.proposalsBySession = new SlidingWindowLimiter(settings.proposalRateLimit, windowMs, now);
    this.proposalsByAddress = new SlidingWindowLimiter(settings.proposalRateLimit, windowMs, now);
    this.approvalsBySession = new SlidingWindowLimiter(settings.approvalRateLimit, windowMs, now);
    this.approvalsByAddress = new SlidingWindowLimiter(settings.approvalRateLimit, windowMs, now);
    this.readsByAddress = new SlidingWindowLimiter(settings.paypalReadRateLimit, windowMs, now);
    this.lookupsBySession = new SlidingWindowLimiter(DISPUTE_LOOKUP_LIMIT, windowMs, now);
    this.lookupsByAddress = new SlidingWindowLimiter(DISPUTE_LOOKUP_LIMIT, windowMs, now);
    this.webhookByAddress = new SlidingWindowLimiter(settings.webhookRateLimit, 60_000, now);
    this.webhookGlobal = new SlidingWindowLimiter(settings.webhookGlobalRateLimit, 60_000, now);
    this.seedBySession = new SlidingWindowLimiter(1, settings.seedSessionIntervalMinutes * 60_000, now);
    this.seedsToday = new DailyCounter(settings.seedDailyCap, now);
    this.writesToday = new DailyCounter(settings.paypalDailyWriteCap, now);
    this.execution = new Semaphore(settings.executionConcurrency);
  }

  private both(a: SlidingWindowLimiter, b: SlidingWindowLimiter, keyA: string, keyB: string, n: number, code: string, what: string): void {
    const wait = Math.max(a.waitSeconds(keyA, n), b.waitSeconds(keyB, n));
    if (wait > 0) {
      throw new LimitError(429, code, `Too many ${what} from your browser or address (limit ${a.max} per ${this.windowMinutes} minutes). Please wait a little and try again.`, wait);
    }
  }

  /** Throws unless `n` more proposals fit for this session and address (does not count them). */
  checkProposals(session: string, address: string, n = 1): void {
    this.both(this.proposalsBySession, this.proposalsByAddress, session, address, n, "proposal_rate_limited", "new proposals");
  }

  takeProposals(session: string, address: string, n = 1): void {
    this.checkProposals(session, address, n);
    this.proposalsBySession.record(session, n);
    this.proposalsByAddress.record(address, n);
  }

  checkApproval(session: string, address: string): void {
    this.both(this.approvalsBySession, this.approvalsByAddress, session, address, 1, "approval_rate_limited", "approvals");
  }

  takeApproval(session: string, address: string): void {
    this.checkApproval(session, address);
    this.approvalsBySession.record(session);
    this.approvalsByAddress.record(address);
  }

  /** One request that reads from PayPal. */
  takeRead(address: string): void {
    const wait = this.readsByAddress.waitSeconds(address);
    if (wait > 0) {
      throw new LimitError(429, "read_rate_limited", `Too many PayPal lookups from your address (limit ${this.readsByAddress.max} per ${this.windowMinutes} minutes). Please wait a little and try again.`, wait);
    }
    this.readsByAddress.record(address);
  }

  /** One "Open a case by ID" lookup (per session and per address). */
  takeDisputeLookup(session: string, address: string): void {
    this.both(this.lookupsBySession, this.lookupsByAddress, session, address, 1, "dispute_lookup_rate_limited", "case lookups");
    this.lookupsBySession.record(session);
    this.lookupsByAddress.record(address);
  }

  takeWebhook(address: string): void {
    const wait = Math.max(this.webhookByAddress.waitSeconds(address), this.webhookGlobal.waitSeconds("all"));
    if (wait > 0) throw new LimitError(429, "webhook_rate_limited", "Too many webhook requests.", wait);
    this.webhookByAddress.record(address);
    this.webhookGlobal.record("all");
  }

  /** Throws unless this session may seed demo data now (once per interval, global daily cap). */
  checkSeed(session: string): void {
    const wait = this.seedBySession.waitSeconds(session);
    if (wait > 0) {
      throw new LimitError(429, "seed_rate_limited", `Demo data can be seeded once per ${Math.round(this.seedBySession.windowMs / 60_000)} minutes per visitor. Try again in about ${Math.ceil(wait / 60)} minute(s).`, wait);
    }
    if (this.seedsToday.remaining() <= 0) {
      throw new LimitError(429, "seed_daily_cap", `The demo's daily limit for seeding demo data (${this.seedsToday.cap}) has been reached. It resets at 00:00 UTC.`, this.seedsToday.secondsUntilReset());
    }
  }

  takeSeed(session: string): void {
    this.checkSeed(session);
    this.seedBySession.record(session);
    this.seedsToday.tryTake();
  }

  /** Reserves `n` PayPal write calls from the global daily cap. */
  reserveWrites(n: number): void {
    if (!this.writesToday.tryTake(n)) {
      throw new LimitError(
        429,
        "paypal_daily_write_cap",
        `The demo's daily limit for PayPal actions (${this.writesToday.cap} calls) would be exceeded (${this.writesToday.remaining()} left). It resets at 00:00 UTC.`,
        this.writesToday.secondsUntilReset(),
      );
    }
  }

  refundWrites(n: number): void {
    this.writesToday.refund(n);
  }

  /** Takes an execution slot or refuses (no queue). */
  acquireExecution(): () => void {
    const release = this.execution.tryAcquire();
    if (!release) throw new LimitError(503, "executor_busy", `The demo is already running ${this.execution.max} approved actions. Please try again in a few seconds.`, 5);
    return release;
  }
}

/** PayPal write calls an approved proposal makes (number + create + send for an invoice). */
export function writeCost(kind: ProposalKind, payload: unknown): number {
  switch (kind) {
    case "create_and_send_invoice":
      return 3;
    case "seed_demo_data": {
      const p = payload as { invoices?: unknown[]; orders?: unknown[] };
      return (p.invoices?.length ?? 0) * 3 + (p.orders?.length ?? 0);
    }
    default:
      return 1;
  }
}
