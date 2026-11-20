import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ListingRaw } from "@pv/shared";
import { adapterFor, futureHomesAdapter } from "../src/scrape/adapters.js";
import { extractGeneric, largestFromSrcset, parseNumber, parsePrice, upgradeImageUrl } from "../src/scrape/extract.js";
import { robotsAllows } from "../src/scrape/policy.js";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const FH_URL = "https://futurehomesinternational.com/property/modern-villa-sea-views-marbella/";

describe("number & price parsing", () => {
  it.each([
    ["€2.450.000", 2450000, "EUR"],
    ["2,450,000 €", 2450000, "EUR"],
    ["£ 1 250 000", 1250000, "GBP"],
    ["Price on request", null, null],
    ["USD 395000", 395000, "USD"],
  ])("%s", (t, price, cur) => {
    const r = parsePrice(t);
    expect(r.price).toBe(price);
    expect(r.currency).toBe(cur);
  });
  it("decimals and thousands", () => {
    expect(parseNumber("85,5 m²")).toBe(85.5);
    expect(parseNumber("1.234 m2")).toBe(1234);
    expect(parseNumber("no digits")).toBeNull();
  });
});

describe("image url helpers", () => {
  it("strips WordPress size suffix and CDN resize params", () => {
    expect(upgradeImageUrl("https://x.com/wp-content/uploads/a/kitchen-1536x1024.jpg")).toBe("https://x.com/wp-content/uploads/a/kitchen.jpg");
    expect(upgradeImageUrl("https://cdn.x.com/img/1.jpg?w=400&v=2")).toBe("https://cdn.x.com/img/1.jpg?v=2");
  });
  it("picks the largest srcset candidate", () => {
    expect(largestFromSrcset("a.jpg 300w, b.jpg 1536w, c.jpg 768w", "https://x.com/")!.url).toBe("https://x.com/b.jpg");
    expect(largestFromSrcset("a.jpg 1x, b.jpg 2x", "https://x.com/")!.url).toBe("https://x.com/b.jpg");
  });
});

describe("futurehomes adapter", () => {
  const listing = futureHomesAdapter.extract(fx("futurehomes-listing.html"), FH_URL, []);

  it("is selected for the domain", () => {
    expect(adapterFor(FH_URL).name).toBe("futurehomes");
    expect(adapterFor("https://www.futurehomesinternational.com/x").name).toBe("futurehomes");
    expect(adapterFor("https://other.example/x").name).toBe("generic");
  });
  it("validates against the ListingRaw schema", () => {
    expect(() => ListingRaw.parse(listing)).not.toThrow();
  });
  it("extracts core facts", () => {
    expect(listing.title).toBe("Modern Villa with Sea Views in Marbella");
    expect(listing.price).toBe(2450000);
    expect(listing.currency).toBe("EUR");
    expect(listing.bedrooms).toBe(4);
    expect(listing.bathrooms).toBe(3);
    expect(listing.sqm).toBe(285);
    expect(listing.floors).toBe(2);
    expect(listing.reference).toBe("FH-1042");
    expect(listing.lat).toBeCloseTo(36.4931);
    expect(listing.lng).toBeCloseTo(-4.9572);
  });
  it("collects full-resolution gallery images and drops theme assets", () => {
    const urls = listing.images.map((i) => i.url);
    expect(urls).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/villa-front.jpg");
    expect(urls).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/living-room.jpg");
    expect(urls).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/kitchen.jpg");
    expect(urls).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/master-bedroom.jpg");
    expect(urls).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/pool-scaled.jpg");
    expect(urls.some((u) => /-\d+x\d+\./.test(u))).toBe(false);
    expect(urls.some((u) => /logo|whatsapp|themes/.test(u))).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });
  it("separates floor plans (images and PDF) and finds video", () => {
    const fp = listing.floorplans.map((f) => f.url);
    expect(fp).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/ground-floor.png");
    expect(fp).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/first-floor.png");
    expect(fp).toContain("https://futurehomesinternational.com/wp-content/uploads/2026/03/floorplans.pdf");
    expect(listing.videos).toEqual([{ url: "https://www.youtube.com/embed/abc123XYZ", kind: "youtube" }]);
    expect(listing.features).toContain("Infinity pool");
  });
});

describe("generic adapter (schema.org)", () => {
  const l = extractGeneric(fx("jsonld-listing.html"), "https://agency.example/listing/42", []);
  it("reads JSON-LD", () => {
    expect(l.title).toBe("Bright 2-bed apartment, Estepona port");
    expect(l.price).toBe(395000);
    expect(l.currency).toBe("EUR");
    expect(l.bedrooms).toBe(2);
    expect(l.bathrooms).toBe(1);
    expect(l.sqm).toBe(85);
    expect(l.lat).toBeCloseTo(36.4259);
    expect(l.location).toBe("Estepona, ES");
  });
  it("collects images, plan PDF and video file", () => {
    const urls = l.images.map((i) => i.url);
    expect(urls).toContain("https://cdn.example-agency.com/img/apt/1.jpg");
    expect(urls).toContain("https://cdn.example-agency.com/img/apt/3-2000.webp");
    expect(l.floorplans.map((f) => f.url)).toContain("https://cdn.example-agency.com/docs/plano-apartamento.pdf");
    expect(l.videos[0]).toEqual({ url: "https://cdn.example-agency.com/video/tour.mp4", kind: "file" });
  });
});

describe("robots.txt", () => {
  const fakeFetch = (body: string, status = 200) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;
  it("respects disallow rules", async () => {
    const f = fakeFetch("User-agent: *\nDisallow: /private/\n");
    expect(await robotsAllows("https://a.example/listing/1", f)).toBe(true);
    expect(await robotsAllows("https://a.example/private/1", f)).toBe(false);
  });
  it("treats a missing robots.txt as allowed", async () => {
    expect(await robotsAllows("https://b.example/x", fakeFetch("", 404))).toBe(true);
  });
  it("refuses when robots.txt errors", async () => {
    await expect(robotsAllows("https://c.example/x", fakeFetch("", 503))).rejects.toThrow(/robots\.txt/);
  });
  it("applies agent-specific groups", async () => {
    const f = fakeFetch("User-agent: PropertyVerseBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n");
    expect(await robotsAllows("https://d.example/x", f)).toBe(false);
  });
});

// End-to-end through a real headless browser against a local server (JS-rendered page).
const hasBrowser = existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers") || !!process.env.CHROMIUM_PATH;
describe.skipIf(!hasBrowser)("playwright rendering", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      // content injected by JavaScript after load, like many listing sites
      res.end(`<!doctype html><html><body><div id="app"></div><script>
        setTimeout(() => { document.getElementById('app').innerHTML =
          '<h1>JS Rendered Villa</h1><span class="price">€ 1.100.000</span><ul><li>Bedrooms: 3</li><li>Size: 210 m²</li></ul>' +
          '<img src="/media/photo-1024x768.jpg" alt="Garden"><img data-src="/media/plan-ground.png" alt="floor plan">'; }, 200);
      </script></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    const { closeBrowser } = await import("../src/scrape/browser.js");
    await closeBrowser();
    server.close();
  });
  it("waits for client-side rendering", async () => {
    const { scrapeListing } = await import("../src/scrape/browser.js");
    const { listing } = await scrapeListing(`${base}/listing/1`);
    expect(listing.title).toBe("JS Rendered Villa");
    expect(listing.price).toBe(1100000);
    expect(listing.bedrooms).toBe(3);
    expect(listing.sqm).toBe(210);
    expect(listing.images.map((i) => i.url)).toContain(`${base}/media/photo.jpg`);
    expect(listing.floorplans.map((f) => f.url)).toContain(`${base}/media/plan-ground.png`);
  }, 60000);
});
