// Sample items for the demo: what a small Japanese seller would type (Japanese),
// plus a fixed English title used only by "Seed demo data" (which runs without AI).
// All items are fictional.
import type { JpItem } from "../agent/schemas.js";

export interface DemoItem {
  key: string;
  item: JpItem;
  seed: { title: string; description: string; price_usd: string };
}

export const DEMO_ITEMS: DemoItem[] = [
  {
    key: "tea-bowl",
    item: {
      title_ja: "手作り 抹茶碗 陶器 一点物",
      description_ja: "ろくろで成形し、灰釉で仕上げた抹茶碗です。直径12cm、高さ8cm。電子レンジは使えません。",
      price_jpy: 12000,
      condition: "handmade",
      category: "陶器",
      weight_g: 350,
    },
    seed: {
      title: "Handmade Japanese Ceramic Matcha Tea Bowl",
      description: "Wheel-thrown stoneware with ash glaze. 12 cm wide, 8 cm tall. One of a kind.",
      price_usd: "80.00",
    },
  },
  {
    key: "film-camera",
    item: {
      title_ja: "中古 フィルムカメラ 35mm 一眼レフ 動作確認済み",
      description_ja: "シャッター、露出計ともに動作確認済みです。小さな擦れがあります。レンズは付属しません。",
      price_jpy: 27000,
      condition: "used_good",
      category: "カメラ",
      weight_g: 600,
    },
    seed: {
      title: "Used 35mm Film SLR Camera Body (Tested)",
      description: "Shutter and light meter tested and working. Small scuffs. Body only, no lens.",
      price_usd: "180.00",
    },
  },
  {
    key: "tetsubin",
    item: {
      title_ja: "南部鉄器 鉄瓶 0.8L 新品",
      description_ja: "岩手の工房で作られた鉄瓶です。容量0.8リットル。箱付き。",
      price_jpy: 18000,
      condition: "new",
      category: "鉄器",
      weight_g: 1300,
    },
    seed: {
      title: "New Japanese Cast Iron Kettle (Tetsubin), 0.8 L",
      description: "Made in an Iwate workshop. 0.8 litre. Comes in its box.",
      price_usd: "120.00",
    },
  },
  {
    key: "kokeshi",
    item: {
      title_ja: "伝統こけし 木製 高さ18cm",
      description_ja: "職人が手で描いた伝統こけしです。少し日焼けがあります。",
      price_jpy: 6000,
      condition: "used_like_new",
      category: "民芸品",
      weight_g: 200,
    },
    seed: {
      title: "Traditional Japanese Wooden Kokeshi Doll, 18 cm",
      description: "Hand-painted by a craftsperson. Slight sun fading.",
      price_usd: "40.00",
    },
  },
];
