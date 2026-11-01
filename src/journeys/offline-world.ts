import { buildInvoicePayload, standardReminderPayload } from "../agent/tasks.js";
import type { DemoBuyers } from "../demo/buyers.js";
import { OfflinePayPal } from "../paypal/offline.js";
import { carrierFor } from "../paypal/carriers.js";
import type { ProposalStore } from "../proposals/store.js";
import { TtlMap } from "../util/ttl-map.js";
import { saleMarker, type SaleRegistry } from "./sales.js";

// The offline demo (PAYPAL_OFFLINE_DEMO=true): every visitor gets a private, in-memory
// "sandbox" seeded with a few sales at different steps, so the journey, the approvals inbox
// and the insights have something to show without any credentials. Nothing reaches PayPal.

export const OFFLINE_WORLD_TTL_MS = 24 * 3_600_000;
export const OFFLINE_WORLD_MAX = 500;

/** Built at runtime so no address literal sits in the repository; `.invalid` never resolves. */
export function offlineBuyerEmails(): string[] {
  return [1, 2, 3].map((n) => `offline-buyer-${n}` + "@" + "okuri-offline.invalid");
}

interface SeedSale {
  titleJa: string;
  titleEn: string;
  description: string;
  usd: string;
  buyer: number;
  country: string;
  daysAgo: number;
  /** How far the sale has gone. */
  until: "draft" | "invoice_pending" | "sent" | "paid" | "tracking_pending" | "shipped_disputed" | "delivered";
}

/** Fictional sales; the first one is shown first (like the S3 target). */
const SEED: SeedSale[] = [
  { titleJa: "手作りの花器", titleEn: "Handmade Ceramic Vase", description: "Wheel-thrown stoneware vase with a celadon glaze. 18 cm tall.", usd: "128.00", buyer: 0, country: "US", daysAgo: 0, until: "invoice_pending" },
  { titleJa: "中古 フィルムカメラ 35mm 一眼レフ 動作確認済み", titleEn: "Used 35mm Film SLR Camera Body (Tested)", description: "Shutter and light meter tested and working. Small scuffs. Body only.", usd: "180.00", buyer: 1, country: "CA", daysAgo: 4, until: "tracking_pending" },
  { titleJa: "南部鉄器 鉄瓶 0.8L 新品", titleEn: "New Japanese Cast Iron Kettle (Tetsubin), 0.8 L", description: "Made in an Iwate workshop. 0.8 litre. Comes in its box.", usd: "120.00", buyer: 2, country: "DE", daysAgo: 12, until: "shipped_disputed" },
  { titleJa: "伝統こけし 木製 高さ18cm", titleEn: "Traditional Japanese Wooden Kokeshi Doll, 18 cm", description: "Hand-painted by a craftsperson. Slight sun fading.", usd: "40.00", buyer: 0, country: "GB", daysAgo: 3, until: "sent" },
  { titleJa: "手作り 抹茶碗 陶器 一点物", titleEn: "Handmade Japanese Ceramic Matcha Tea Bowl", description: "Wheel-thrown stoneware with ash glaze. One of a kind.", usd: "80.00", buyer: 1, country: "AU", daysAgo: 20, until: "delivered" },
  { titleJa: "藍染め 手ぬぐい 綿100% 職人による手染め 伝統柄 二枚組 ギフト包装可", titleEn: "Indigo-Dyed Cotton Tenugui Towels, Set of Two", description: "Hand-dyed by a craftsperson in a traditional pattern. 100% cotton.", usd: "36.00", buyer: 2, country: "FR", daysAgo: 0, until: "draft" },
];

const ORDER: SeedSale["until"][] = ["draft", "invoice_pending", "sent", "paid", "tracking_pending", "shipped_disputed", "delivered"];
const reached = (s: SeedSale, step: SeedSale["until"]) => ORDER.indexOf(s.until) >= ORDER.indexOf(step);

export interface OfflineWorldDeps {
  registry: SaleRegistry;
  proposals: ProposalStore;
  buyers: DemoBuyers;
  sellerBusinessName?: string;
  /** Offline AI label for the seeded drafts. */
  draftedBy: { provider: string; model?: string };
  now?: () => number;
}

/** One simulated PayPal per demo session, created and seeded on first use. */
export class OfflineWorlds {
  private readonly worlds: TtlMap<string, OfflinePayPal>;

  constructor(private readonly deps: OfflineWorldDeps) {
    this.worlds = new TtlMap({ ttlMs: OFFLINE_WORLD_TTL_MS, max: OFFLINE_WORLD_MAX, ...(deps.now ? { now: deps.now } : {}) });
  }

  /** The visitor's simulated PayPal, if it exists already. */
  peek(session: string): OfflinePayPal | undefined {
    return this.worlds.get(session);
  }

  /** The visitor's simulated PayPal; seeds it on first use. `address` bounds pending proposals. */
  async get(session: string, address?: string): Promise<OfflinePayPal> {
    const existing = this.worlds.get(session);
    if (existing) return existing;
    const now = this.deps.now?.() ?? Date.now();
    const paypal = new OfflinePayPal(() => new Date(this.deps.now?.() ?? Date.now()));
    this.worlds.set(session, paypal);
    this.deps.registry.removeOwner(session);
    await this.seed(session, address, paypal, now);
    return paypal;
  }

  private async seed(session: string, address: string | undefined, paypal: OfflinePayPal, now: number): Promise<void> {
    const { registry, proposals, buyers } = this.deps;
    const iso = (daysAgo: number, minutes: number) => new Date(now - daysAgo * 86_400_000 + minutes * 60_000).toISOString();
    // Created in reverse so the first seed sale is the newest.
    for (const s of [...SEED].reverse()) {
      const alias = buyers.at(s.buyer).alias;
      const listing = { title: s.titleEn, description: s.description, price: { currency_code: "USD", value: s.usd }, quantity: 1 };
      const sale = registry.create({
        owner: session,
        createdAt: iso(s.daysAgo, -60),
        titleJa: s.titleJa,
        titleEn: s.titleEn,
        listing,
        buyerAlias: alias,
        country: s.country,
        amount: listing.price,
        path: "invoice",
        draftedBy: this.deps.draftedBy,
      });
      registry.note(sale, "Item added (Japanese)", iso(s.daysAgo, -60));
      registry.note(sale, "English draft prepared", iso(s.daysAgo, -59));
      const payload = buildInvoicePayload(listing, alias, { note: `Thank you for your order of "${s.titleEn}". You can pay securely with PayPal.` }, this.deps.sellerBusinessName, saleMarker(sale.id, s.country));
      if (!reached(s, "invoice_pending")) continue;
      if (s.until === "invoice_pending") {
        this.tryPropose(() => proposals.propose("create_and_send_invoice", `Send invoice for USD ${s.usd} to ${alias}: ${s.titleEn}`, payload, { owner: session, saleId: sale.id, ...(address ? { address } : {}) }));
        registry.note(sale, "Invoice prepared, awaiting your approval", iso(s.daysAgo, -58));
        continue;
      }
      // Sent through the simulator, as the executor would.
      const invoice = structuredClone(payload.invoice);
      invoice.detail.invoice_number = await paypal.generateNextInvoiceNumber();
      invoice.primary_recipients = [{ billing_info: { email_address: buyers.resolve(alias)!.email } }];
      const created = await paypal.createDraftInvoice(invoice);
      await paypal.sendInvoice(created.id);
      paypal.setInvoiceDate(created.id, iso(s.daysAgo, 0).slice(0, 10));
      registry.attachInvoice(sale.id, created.id, invoice.detail.invoice_number);
      registry.note(sale, `Invoice ${invoice.detail.invoice_number} sent via PayPal`, iso(s.daysAgo, -50));
      if (s.until === "sent") {
        this.tryPropose(() =>
          proposals.propose("send_invoice_reminder", `Send PayPal's standard reminder for invoice ${invoice.detail.invoice_number}`, standardReminderPayload(created.id), {
            owner: session,
            saleId: sale.id,
            copyForDm: `Hi! Just a friendly note that the invoice for "${s.titleEn}" (USD ${s.usd}) is still open. You may also get a reminder email from PayPal. Thank you!`,
            ...(address ? { address } : {}),
          }),
        );
        continue;
      }
      const tx = paypal.simulateInvoicePayment(created.id, new Date(now - (s.daysAgo - 1) * 86_400_000));
      sale.transactionId = tx;
      sale.paidAt = iso(s.daysAgo - 1, 0);
      registry.note(sale, "Buyer paid the invoice through PayPal", sale.paidAt);
      const carrier = "Japan Post";
      const number = `EJ${String(100000000 + Math.floor((now / 1000) % 89999999) + s.daysAgo).slice(0, 9)}JP`;
      if (s.until === "tracking_pending") {
        this.tryPropose(() =>
          proposals.propose(
            "add_invoice_tracking",
            `Add ${carrier} tracking ${number} to ${sale.id}`,
            { trackers: [{ transaction_id: tx, tracking_number: number, status: "SHIPPED", ...carrierFor(carrier, "shipping"), notify_buyer: true }] },
            { owner: session, saleId: sale.id, ...(address ? { address } : {}) },
          ),
        );
        registry.note(sale, "Tracking number checked, awaiting your approval", iso(0, -5));
        continue;
      }
      await paypal.addTrackersBatch([{ transaction_id: tx, tracking_number: number, status: "SHIPPED", ...carrierFor(carrier, "shipping"), notify_buyer: true }]);
      sale.tracking = { carrier, number, at: iso(s.daysAgo - 2, 0) };
      registry.note(sale, `Tracking ${number} (${carrier}) registered with PayPal`, sale.tracking.at);
      if (s.until === "shipped_disputed") {
        paypal.simulateDispute(created.id, { at: new Date(now - 2 * 86_400_000) });
        continue;
      }
      sale.deliveredAt = iso(s.daysAgo - 9, 0);
      registry.note(sale, "Delivered (offline simulation)", sale.deliveredAt);
    }
  }

  private tryPropose(fn: () => unknown): void {
    try {
      fn();
    } catch {
      // Queue full or too many pending from this address: the sale still shows, without a proposal.
    }
  }
}
