import * as cheerio from "cheerio";
import type { ListingRaw } from "@pv/shared";
import { absolutize, extractGeneric, parseNumber, parsePrice, upgradeImageUrl } from "./extract.js";

export interface SiteAdapter {
  name: string;
  matches(url: URL): boolean;
  /** CSS selector to wait for after navigation (JS-rendered pages) */
  waitFor?: string;
  /** optional in-page actions before HTML is captured (open galleries, expand descriptions) */
  prepare?: string[];
  extract(html: string, url: string, networkImages: string[]): ListingRaw;
}

export const genericAdapter: SiteAdapter = {
  name: "generic",
  matches: () => true,
  extract: (html, url, net) => extractGeneric(html, url, net),
};

/**
 * futurehomesinternational.com
 *
 * Built on the generic extractor (schema.org/OG/label-value parsing) plus the patterns of
 * WordPress real-estate themes (Houzez / RealHomes style markup, wp-content uploads).
 * NOTE: written without access to the live site from the build environment; the selectors
 * below are validated against the fixture in test/fixtures and should be re-checked with
 * `pnpm --filter @pv/worker scrape <listing-url>` once the site is reachable.
 */
export const futureHomesAdapter: SiteAdapter = {
  name: "futurehomes",
  matches: (u) => /(^|\.)futurehomesinternational\.com$/i.test(u.hostname),
  waitFor: "h1",
  prepare: [
    // expand "read more" descriptions and trigger lazy galleries
    "document.querySelectorAll('[class*=read-more],[class*=readmore]').forEach(e=>e.click())",
  ],
  extract(html, url, net) {
    const base = extractGeneric(html, url, net);
    const $ = cheerio.load(html);
    const txt = (sel: string) => $(sel).first().text().replace(/\s+/g, " ").trim() || null;

    const title = txt(".page-title h1, .property-title h1, h1.entry-title, .rh_page__title, h1") ?? base.title;
    const priceText =
      txt(".item-price, .property-price, .price-wrap .price, .rh_page__property_price .price, [class*='price'] .amount") ?? base.priceText;
    const { price, currency } = parsePrice(priceText);

    const detail = (re: RegExp) => {
      let v: string | null = null;
      $(".detail-wrap li, .property-overview-data li, .rh_property__meta, .property-detail li, .houzez-detail li, .listing-details li").each(
        (_, el) => {
          const t = $(el).text().replace(/\s+/g, " ").trim();
          if (!v && re.test(t)) v = t;
        },
      );
      return v as string | null;
    };
    const bedrooms = parseNumber(detail(/bed|dormitor/i)) ?? base.bedrooms;
    const bathrooms = parseNumber(detail(/bath|baño/i)) ?? base.bathrooms;
    const sqmRaw = detail(/m²|m2|sq|size|built|area/i);
    const sqm = (sqmRaw ? parseNumber(sqmRaw) : null) ?? base.sqm;
    const reference = (detail(/ref|property id/i)?.split(/[:\s]/).pop() ?? null) || base.reference;

    // gallery: the full-size originals are in data attributes / lightbox links
    const images = new Map(base.images.map((i) => [i.url, i]));
    $(".property-gallery a, .houzez-photoswipe a, .gallery a, [data-fancybox] , .rh_property__slider a, .swiper-slide img, .slick-slide img")
      .each((_, el) => {
        const e = $(el);
        const u = absolutize(e.attr("href") ?? e.attr("data-src") ?? e.attr("data-full") ?? e.attr("src"), url);
        if (u && /\/wp-content\/uploads\//.test(u) && /\.(jpe?g|png|webp)/i.test(u)) {
          const full = upgradeImageUrl(u);
          if (!images.has(full)) images.set(full, { url: full, alt: e.attr("title") ?? null, width: null });
        }
      });
    // prefer uploads from the site itself (drop theme assets and third-party pixels)
    const own = [...images.values()].filter((i) => /\/wp-content\/uploads\//.test(i.url) || !/futurehomesinternational\.com/.test(i.url));
    const floorplans = [...base.floorplans];
    $(".floor-plans-wrap img, .floor-plan img, [class*='floor-plan'] img, [id*='floor-plan'] img, [class*='floorplan'] a")
      .each((_, el) => {
        const u = absolutize($(el).attr("data-src") ?? $(el).attr("src") ?? $(el).attr("href"), url);
        if (u && !floorplans.some((f) => f.url === upgradeImageUrl(u))) floorplans.push({ url: upgradeImageUrl(u), label: $(el).attr("alt") ?? null });
      });

    return {
      ...base,
      adapter: "futurehomes",
      title,
      priceText,
      price: price ?? base.price,
      currency: currency ?? base.currency ?? "EUR",
      bedrooms,
      bathrooms,
      sqm,
      reference,
      images: own.filter((i) => !floorplans.some((f) => f.url === i.url)),
      floorplans,
    };
  },
};

export const ADAPTERS: SiteAdapter[] = [futureHomesAdapter, genericAdapter];

export function adapterFor(url: string): SiteAdapter {
  const u = new URL(url);
  return ADAPTERS.find((a) => a.matches(u)) ?? genericAdapter;
}
