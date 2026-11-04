// Captures the Red Pen layer on the live Studio at full resolution (headless Edge via Playwright).
// Usage: node scripts/screenshot-redpen.mjs [outDir]  (server on :4310 with a stale-price campaign; see scripts/live-e2e.mjs)
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "docs/evidence";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 1.5 });
page.on("response", (r) => r.status() >= 400 && console.log("HTTP", r.status(), r.url()));
await page.goto("http://127.0.0.1:4310/?studio=1");
await page.fill('input[type="password"]', "local-demo");
await page.getByRole("button", { name: /Open workspace/ }).click();
await page.getByRole("button", { name: "Clay & Co" }).first().click();
await page.locator("button", { hasText: "Publish" }).first().click();
await page.getByRole("button", { name: "Run preflight" }).click();
await page.waitForSelector('[class*="redpen"] svg text', { timeout: 40000, state: "attached" });
await page.waitForTimeout(3000);
const root = page.locator('[class*="redpen"]').first();
await root.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${out}/redpen-live-viewport.png` });
await root.screenshot({ path: `${out}/redpen-live.png` });
if (process.argv[3] === "fix") {
  await page.getByRole("button", { name: /Fix with Axys/ }).click();
  await page.waitForFunction(() => /fixed/i.test([...document.querySelectorAll("[aria-live]")].map((e) => e.textContent).join(" ")), null, { timeout: 240000 });
  await page.waitForTimeout(3500);
  await root.scrollIntoViewIfNeeded();
  await root.screenshot({ path: `${out}/redpen-live-fixed.png` });
  console.log("fixed state captured");
}
console.log("captured");
await browser.close();
