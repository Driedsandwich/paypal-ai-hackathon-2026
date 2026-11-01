import { TtlMap } from "../util/ttl-map.js";

export interface RegisteredOrder {
  /** Session that created the payment link; the capture proposal belongs to it. */
  owner: string;
  /** Capture proposal queued for this order, if any (de-duplication independent of the store). */
  captureProposalId?: string;
}

export const ORDER_REGISTRY_TTL_MS = 3 * 86_400_000;
export const ORDER_REGISTRY_MAX = 2_000;

/**
 * Orders v2 ids created by this server (bounded, entries expire after 3 days). Only these
 * orders can be captured through the return page or the capture route.
 */
export class OrderRegistry {
  private readonly orders: TtlMap<string, RegisteredOrder>;

  constructor(options: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.orders = new TtlMap({ ttlMs: options.ttlMs ?? ORDER_REGISTRY_TTL_MS, max: options.max ?? ORDER_REGISTRY_MAX, ...(options.now ? { now: options.now } : {}) });
  }

  register(orderId: string, owner: string): void {
    this.orders.set(orderId, { owner });
  }

  get(orderId: string): RegisteredOrder | undefined {
    return this.orders.get(orderId);
  }
}
