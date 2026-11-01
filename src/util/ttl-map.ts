/**
 * A Map whose entries expire after `ttlMs` and that never holds more than `max` entries
 * (the oldest entries are dropped first). In memory, per process.
 */
export class TtlMap<K, V> {
  private readonly items = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly options: { ttlMs: number; max: number; now?: () => number },
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get(key: K): V | undefined {
    const e = this.items.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) {
      this.items.delete(key);
      return undefined;
    }
    return e.value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  /** Adds or replaces an entry; its expiry starts now (or after `ttlMs` if given). */
  set(key: K, value: V, ttlMs = this.options.ttlMs): void {
    this.items.delete(key);
    this.items.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.items.size > this.options.max) this.prune();
  }

  delete(key: K): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, e] of this.items) if (e.expiresAt <= t) this.items.delete(k);
    for (const k of this.items.keys()) {
      if (this.items.size <= this.options.max) break;
      this.items.delete(k);
    }
  }
}
