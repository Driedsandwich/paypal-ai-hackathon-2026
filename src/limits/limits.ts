// Small in-memory limit primitives (per process). If the app ever runs as several replicas,
// each one enforces its own copy of these limits.

/** A refusal with an HTTP status, a stable code and a message for the visitor. */
export class LimitError extends Error {
  constructor(
    readonly status: 429 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "LimitError";
  }
}

const MAX_KEYS = 20_000;

/** At most `max` events per key within a sliding window of `windowMs`. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string, t: number): number[] {
    const since = t - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((x) => x > since);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until `n` more events fit for this key (0 = they fit now). */
  waitSeconds(key: string, n = 1): number {
    const t = this.now();
    const list = this.recent(key, t);
    if (list.length + n <= this.max) return 0;
    if (n > this.max) return Math.ceil(this.windowMs / 1000);
    const oldestToDrop = list[list.length + n - this.max - 1]!;
    return Math.max(1, Math.ceil((oldestToDrop + this.windowMs - t) / 1000));
  }

  /** Records `n` events (call after waitSeconds() returned 0). */
  record(key: string, n = 1): void {
    const t = this.now();
    const list = this.recent(key, t);
    for (let i = 0; i < n; i++) list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > MAX_KEYS) this.prune(t);
  }

  private prune(t: number): void {
    for (const k of [...this.hits.keys()]) this.recent(k, t);
    for (const k of this.hits.keys()) {
      if (this.hits.size <= MAX_KEYS) break;
      this.hits.delete(k);
    }
  }
}

/** A global counter that resets at 00:00 UTC. */
export class DailyCounter {
  private day = "";
  private count = 0;

  constructor(
    readonly cap: number,
    private readonly now: () => number = Date.now,
  ) {}

  private rollover(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
  }

  used(): number {
    this.rollover();
    return this.count;
  }

  remaining(): number {
    return Math.max(0, this.cap - this.used());
  }

  /** Takes `n` units if they are all available. */
  tryTake(n = 1): boolean {
    this.rollover();
    if (this.count + n > this.cap) return false;
    this.count += n;
    return true;
  }

  refund(n = 1): void {
    this.rollover();
    this.count = Math.max(0, this.count - n);
  }

  secondsUntilReset(): number {
    const t = this.now();
    const next = Date.parse(`${new Date(t).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
    return Math.max(1, Math.ceil((next - t) / 1000));
  }
}

/** A counting semaphore without a queue: callers either get a slot now or are refused. */
export class Semaphore {
  private inUse = 0;

  constructor(readonly max: number) {}

  get active(): number {
    return this.inUse;
  }

  /** A release function, or undefined when all slots are taken. */
  tryAcquire(): (() => void) | undefined {
    if (this.inUse >= this.max) return undefined;
    this.inUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
    };
  }
}
