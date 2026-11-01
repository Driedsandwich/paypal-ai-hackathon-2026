#!/usr/bin/env node
// Screenshots of the offline demo (PAYPAL_OFFLINE_DEMO=true, fake AI) at 1440x900 and 390x844.
// Usage: npm run build && node scripts/screenshots.mjs [outDir] [view ...]
// Needs Playwright with Chromium (not a project dependency). Starts dist/server.js on a free port.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const outDir = process.argv[2] ?? "docs/media";
const only = process.argv.slice(3);
mkdirSync(outDir, { recursive: true });

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const env = { ...process.env, PORT: String(port), PAYPAL_OFFLINE_DEMO: "true", AI_PROVIDER: "", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "" };
const server = spawn(process.execPath, ["dist/server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => server.stdout.on("data", (d) => String(d).includes("Listening") && resolve()));
const base = `http://localhost:${port}`;

const shots = [
  { name: "journey", hash: "#journeys" },
  { name: "journey-dispute", hash: "#journeys", pick: "dispute" },
  { name: "approvals", hash: "#approvals" },
  { name: "new-item", hash: "#new" },
  { name: "disputes", hash: "#disputes" },
  { name: "insights", hash: "#insights", wait: 6000 },
];
const sizes = [
  { tag: "desktop", width: 1440, height: 900 },
  { tag: "mobile", width: 390, height: 844, mobile: true },
];

const browser = await chromium.launch();
try {
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: Boolean(size.mobile), hasTouch: Boolean(size.mobile) });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));
    await page.goto(`${base}/`);
    await page.waitForSelector(".count-num");
    for (const s of shots) {
      if (only.length && !only.includes(s.name)) continue;
      let hash = s.hash;
      if (s.pick !== undefined) {
        const id = await page.evaluate(async () => (await (await fetch("/api/journeys")).json()).data.journeys.find((j) => j.dispute)?.id);
        hash = `#journeys/${id ?? ""}`;
      }
      await page.goto(`${base}/${hash}`);
      await page.waitForLoadState("networkidle");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(s.wait ?? 400);
      const file = path.join(outDir, `${s.name}-${size.tag}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    if (size.mobile && (!only.length || only.includes("menu"))) {
      await page.goto(`${base}/#journeys`);
      await page.waitForLoadState("networkidle");
      await page.click(".menu-btn");
      await page.waitForTimeout(300);
      const file = path.join(outDir, `journey-menu-open-mobile.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
