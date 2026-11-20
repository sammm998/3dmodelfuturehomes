import { chromium, type Browser } from "playwright-core";
import { env } from "@pv/server";
import type { ListingRaw } from "@pv/shared";
import { adapterFor } from "./adapters.js";

let browser: Browser | null = null;

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  return browser;
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}

/** Render a (JS-heavy) listing page and extract it with the matching site adapter. */
export async function scrapeListing(url: string): Promise<{ listing: ListingRaw; html: string }> {
  const adapter = adapterFor(url);
  const b = await getBrowser();
  const ctx = await b.newContext({ userAgent: env.userAgent, viewport: { width: 1440, height: 1000 }, locale: "en-GB" });
  const page = await ctx.newPage();
  const netImages = new Set<string>();
  page.on("response", (res) => {
    const ct = res.headers()["content-type"] ?? "";
    if (ct.startsWith("image/") && res.status() === 200) netImages.add(res.url());
  });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (adapter.waitFor) await page.waitForSelector(adapter.waitFor, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    for (const js of adapter.prepare ?? []) await page.evaluate(js).catch(() => {});
    // scroll to trigger lazy-loaded galleries
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    const listing = adapter.extract(html, page.url(), [...netImages]);
    return { listing, html };
  } finally {
    await ctx.close();
  }
}
