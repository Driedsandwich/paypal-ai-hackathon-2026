// Maps free-text carrier names (as a seller types them) to PayPal carrier codes.
// The two tracking APIs use different enums (checked against PayPal's OpenAPI specs):
//  - Orders v2 /track uses `shipment_carrier` (has OTHER, SAGAWA, YAMATO)
//  - Add Tracking v1 /trackers-batch uses `carrier` (has JPN_SAGAWA, JP_KURO_NEKO_YAMATO_UNYUU)
// Unknown names fall back to OTHER + carrier_name_other.

export type TrackingApi = "orders" | "shipping";

export interface CarrierCode {
  carrier: string;
  carrier_name_other?: string;
}

const ALIASES: Array<{ match: RegExp; orders: string; shipping: string }> = [
  { match: /japan\s*post|日本郵便|ゆうパック|yu-?pack|\bems\b|国際郵便/i, orders: "JPN_JAPAN_POST", shipping: "JPN_JAPAN_POST" },
  { match: /yamato|kuroneko|kuro\s*neko|ヤマト|クロネコ/i, orders: "YAMATO", shipping: "JP_KURO_NEKO_YAMATO_UNYUU" },
  { match: /sagawa|佐川/i, orders: "SAGAWA", shipping: "JPN_SAGAWA" },
  { match: /^dhl\s*(japan|jp)$/i, orders: "DHL_JP", shipping: "DHL_JP" },
  { match: /^dhl(\s*express)?$/i, orders: "DHL", shipping: "DHL" },
  { match: /^fed\s*ex$/i, orders: "FEDEX", shipping: "FEDEX" },
  { match: /^ups$/i, orders: "UPS", shipping: "UPS" },
  { match: /^usps$/i, orders: "USPS", shipping: "USPS" },
];

export function carrierFor(name: string, api: TrackingApi): CarrierCode {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("carrier name is required");
  for (const a of ALIASES) {
    if (a.match.test(trimmed)) return { carrier: api === "orders" ? a.orders : a.shipping };
  }
  return { carrier: "OTHER", carrier_name_other: trimmed.slice(0, 64) };
}
