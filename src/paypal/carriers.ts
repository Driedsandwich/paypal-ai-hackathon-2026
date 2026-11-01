// Maps free-text carrier names (as a seller types them) to PayPal carrier codes.
// The two tracking APIs use different enums (checked against PayPal's OpenAPI specs):
//  - Orders v2 /track uses `shipment_carrier` (has OTHER, SAGAWA, YAMATO)
//  - Add Tracking v1 /trackers-batch uses `carrier` (has JPN_SAGAWA, JP_KURO_NEKO_YAMATO_UNYUU)
//  - Disputes v1 evidence uses `tracking_info.carrier_name` (has JPN_JAPAN_POST, JPN_YAMATO, JPN_SAGAWA)
// Unknown names fall back to OTHER + carrier_name_other.

export type TrackingApi = "orders" | "shipping" | "disputes";

export interface CarrierCode {
  carrier: string;
  carrier_name_other?: string;
}

const ALIASES: Array<{ match: RegExp } & Record<TrackingApi, string>> = [
  { match: /japan\s*post|日本郵便|ゆうパック|yu-?pack|\bems\b|国際郵便/i, orders: "JPN_JAPAN_POST", shipping: "JPN_JAPAN_POST", disputes: "JPN_JAPAN_POST" },
  { match: /yamato|kuroneko|kuro\s*neko|ヤマト|クロネコ/i, orders: "YAMATO", shipping: "JP_KURO_NEKO_YAMATO_UNYUU", disputes: "JPN_YAMATO" },
  { match: /sagawa|佐川/i, orders: "SAGAWA", shipping: "JPN_SAGAWA", disputes: "JPN_SAGAWA" },
  { match: /^dhl\s*(japan|jp)$/i, orders: "DHL_JP", shipping: "DHL_JP", disputes: "DHL_JP" },
  { match: /^dhl(\s*express)?$/i, orders: "DHL", shipping: "DHL", disputes: "DHL" },
  { match: /^fed\s*ex$/i, orders: "FEDEX", shipping: "FEDEX", disputes: "FEDEX" },
  { match: /^ups$/i, orders: "UPS", shipping: "UPS", disputes: "UPS" },
  { match: /^usps$/i, orders: "USPS", shipping: "USPS", disputes: "USPS" },
];

export function carrierFor(name: string, api: TrackingApi): CarrierCode {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("carrier name is required");
  for (const a of ALIASES) {
    if (a.match.test(trimmed)) return { carrier: a[api] };
  }
  return { carrier: "OTHER", carrier_name_other: trimmed.slice(0, 64) };
}
