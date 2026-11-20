import * as cheerio from "cheerio";
import type { ListingRaw } from "@pv/shared";

type $ = cheerio.CheerioAPI;

const IMG_EXT = /\.(jpe?g|png|webp|avif)(\?|#|$)/i;
const SKIP_IMG = /(logo|icon|sprite|avatar|favicon|placeholder|loader|blank|flag|badge|marker|pin|whatsapp|facebook|instagram|twitter|linkedin|youtube|qr[-_]?code|gravatar|emoji|captcha)/i;

export function absolutize(u: string | undefined | null, base: string): string | null {
  if (!u) return null;
  const s = u.trim();
  if (!s || s.startsWith("data:") || s.startsWith("javascript:")) return null;
  try {
    return new URL(s, base).toString();
  } catch {
    return null;
  }
}

/** Pick the largest candidate from a srcset attribute. */
export function largestFromSrcset(srcset: string | undefined, base: string): { url: string; width: number | null } | null {
  if (!srcset) return null;
  let best: { url: string; width: number | null; score: number } | null = null;
  for (const part of srcset.split(/,(?=\s*\S+\s+\d+(?:\.\d+)?[wx])|,\s+(?=https?:|\/)/)) {
    const [u, d] = part.trim().split(/\s+/);
    const url = absolutize(u, base);
    if (!url) continue;
    const m = d?.match(/^(\d+(?:\.\d+)?)([wx])$/);
    const score = m ? Number(m[1]) * (m[2] === "x" ? 1000 : 1) : 1;
    if (!best || score > best.score) best = { url, width: m && m[2] === "w" ? Number(m[1]) : null, score };
  }
  return best ? { url: best.url, width: best.width } : null;
}

/**
 * Upgrade CMS thumbnail URLs to the original upload:
 *  - WordPress: image-1024x768.jpg -> image.jpg, also "-scaled" variants are kept (they are the full size)
 *  - common CDN resize params (?w=, ?width=, ?resize=) removed
 */
export function upgradeImageUrl(url: string): string {
  let u = url.replace(/-\d{2,5}x\d{2,5}(?=\.(jpe?g|png|webp|avif)(\?|#|$))/i, "");
  try {
    const p = new URL(u);
    for (const k of ["w", "h", "width", "height", "resize", "fit", "quality", "q", "crop"]) p.searchParams.delete(k);
    u = p.toString().replace(/\?$/, "");
  } catch {
    /* keep */
  }
  return u;
}

export function parseNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/ /g, " ").match(/\d{1,3}(?:[ .,’']\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/);
  if (!m) return null;
  let n = m[0].replace(/[ ’']/g, "");
  // "1.250.000" or "1,250,000" -> thousands; "85,5" -> decimal
  if (/^\d{1,3}([.,]\d{3})+$/.test(n)) n = n.replace(/[.,]/g, "");
  else n = n.replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

export function parsePrice(text: string | null | undefined): { price: number | null; currency: string | null } {
  if (!text) return { price: null, currency: null };
  const t = text.replace(/\s+/g, " ");
  const cur = /€|eur/i.test(t) ? "EUR" : /£|gbp/i.test(t) ? "GBP" : /\$|usd/i.test(t) ? "USD" : /\bsek\b|kr\b/i.test(t) ? "SEK" : /aed/i.test(t) ? "AED" : null;
  if (/price on (request|application)|poa|consultar/i.test(t)) return { price: null, currency: cur };
  const price = parseNumber(t);
  return { price: price && price >= 1000 ? price : null, currency: cur };
}

function jsonLd($: $): any[] {
  const out: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = (d: any) => {
        if (Array.isArray(d)) d.forEach(walk);
        else if (d && typeof d === "object") {
          out.push(d);
          if (d["@graph"]) walk(d["@graph"]);
        }
      };
      walk(data);
    } catch {
      /* ignore malformed */
    }
  });
  return out;
}

const meta = ($: $, ...names: string[]) => {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr("content") ?? $(`meta[name="${n}"]`).attr("content");
    if (v) return v.trim();
  }
  return null;
};

/** Label/value pairs from definition lists, tables and "Label: value" list items. */
export function labelValues($: $): Map<string, string> {
  const m = new Map<string, string>();
  const put = (k: string, v: string) => {
    const key = k.toLowerCase().replace(/[:\s]+$/g, "").replace(/\s+/g, " ").trim();
    const val = v.replace(/\s+/g, " ").trim();
    if (key && val && key.length < 40 && val.length < 120 && !m.has(key)) m.set(key, val);
  };
  $("dt").each((_, el) => put($(el).text(), $(el).next("dd").text()));
  $("tr").each((_, el) => {
    const c = $(el).find("th,td");
    if (c.length === 2) put($(c[0]).text(), $(c[1]).text());
  });
  $("li, .detail, .meta, .feature, [class*=detail] div, [class*=feature] div").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    const mm = t.match(/^([A-Za-zÀ-ÿ /²]+?)\s*:\s*(.+)$/);
    if (mm) put(mm[1], mm[2]);
    // "<strong>3</strong> Bedrooms" style
    const nm = t.match(/^(\d+(?:[.,]\d+)?)\s*(bed(room)?s?|bath(room)?s?|m²|m2|sqm|sq\.? ?m)$/i);
    if (nm) put(nm[2], nm[1]);
  });
  return m;
}

const findLV = (lv: Map<string, string>, re: RegExp) => {
  for (const [k, v] of lv) if (re.test(k)) return v;
  return null;
};

/** Generic extractor: JSON-LD (schema.org), OpenGraph, label/value pairs, text patterns and every large image. */
export function extractGeneric(html: string, url: string, extraImageUrls: string[] = []): ListingRaw {
  const $ = cheerio.load(html);
  const ld = jsonLd($);
  const listing =
    ld.find((d) => /Residence|House|Apartment|SingleFamilyResidence|Accommodation|RealEstateListing|Product|Offer/i.test(String(d["@type"]))) ?? null;
  const text = $("body").text().replace(/\s+/g, " ");
  const lv = labelValues($);

  const title =
    (listing?.name as string) || meta($, "og:title") || $("h1").first().text().trim() || $("title").text().trim() || "Untitled property";

  // price
  const offers = listing?.offers ? (Array.isArray(listing.offers) ? listing.offers[0] : listing.offers) : null;
  let price: number | null = offers?.price != null ? parseNumber(String(offers.price)) : null;
  let currency: string | null = offers?.priceCurrency ?? meta($, "product:price:currency", "og:price:currency");
  let priceText: string | null = null;
  const priceEl = $('[class*="price" i], [id*="price" i], [itemprop="price"]').first();
  if (priceEl.length) priceText = priceEl.text().replace(/\s+/g, " ").trim().slice(0, 80) || null;
  if (!priceText) priceText = findLV(lv, /^(price|precio|pris)$/);
  if (!priceText) priceText = text.match(/(?:€|EUR|£|\$)\s?\d[\d.,\s]{3,}|\d[\d.,\s]{3,}\s?(?:€|EUR)/)?.[0] ?? null;
  if (price == null && priceText) ({ price, currency } = { ...parsePrice(priceText), currency: currency ?? parsePrice(priceText).currency });

  const num = (re: RegExp, textRe: RegExp) => parseNumber(findLV(lv, re)) ?? parseNumber(text.match(textRe)?.[1]);
  const bedrooms = (listing?.numberOfRooms as number) ?? num(/^(bed(room)?s?|dormitorios|sovrum)$/, /(\d+)\s*(?:bed(?:room)?s?|dormitorios|sovrum)\b/i);
  const bathrooms = (listing?.numberOfBathroomsTotal as number) ?? num(/^(bath(room)?s?|baños|badrum)$/, /(\d+)\s*(?:bath(?:room)?s?|baños|badrum)\b/i);
  let sqm =
    parseNumber(listing?.floorSize?.value) ??
    num(/^(built|size|area|built area|living area|m²|m2|sqm|superficie|construidos|interior|boyta)/, /(\d[\d.,]*)\s*(?:m²|m2|sqm|sq\.?\s?m)\b/i);
  if (sqm != null && (sqm < 10 || sqm > 20000)) sqm = null;
  const floors = num(/^(floors|storeys|stories|plantas|våningar)$/, /(\d+)\s*(?:floors|storeys|stories|plantas|levels)\b/i);

  // location & coordinates
  const addr = listing?.address;
  const location =
    (typeof addr === "string" ? addr : [addr?.streetAddress, addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean).join(", ")) ||
    findLV(lv, /^(location|address|ubicación|område|area|town|city)$/) ||
    meta($, "og:locality", "place:location") ||
    null;
  let lat: number | null = Number(listing?.geo?.latitude ?? meta($, "place:location:latitude", "og:latitude") ?? NaN);
  let lng: number | null = Number(listing?.geo?.longitude ?? meta($, "place:location:longitude", "og:longitude") ?? NaN);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    lat = lng = null;
    const sources = [
      ...$("iframe[src*='maps'], a[href*='maps'], [data-lat], [data-latitude]")
        .map((_, el) => [$(el).attr("src"), $(el).attr("href"), `${$(el).attr("data-lat") ?? $(el).attr("data-latitude")},${$(el).attr("data-lng") ?? $(el).attr("data-longitude") ?? $(el).attr("data-lon")}`].join(" "))
        .get(),
      html.match(/"lat(?:itude)?"\s*:\s*"?(-?\d{1,2}\.\d{3,})"?\s*,\s*"(?:lng|lon|longitude)"\s*:\s*"?(-?\d{1,3}\.\d{3,})/)?.slice(1, 3).join(",") ?? "",
    ];
    for (const s of sources) {
      const m = s.match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/) ?? s.match(/[?&]q=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
      if (m) {
        const a = Number(m[1]),
          b = Number(m[2]);
        if (Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0)) {
          lat = a;
          lng = b;
          break;
        }
      }
    }
  }

  const description =
    (listing?.description as string) ||
    $('[class*="description" i]').first().text().replace(/\s+/g, " ").trim().slice(0, 4000) ||
    meta($, "og:description", "description");

  // ---------- media ----------
  const images = new Map<string, { url: string; alt: string | null; width: number | null }>();
  const floorplans = new Map<string, { url: string; label: string | null }>();
  const addImg = (raw: string | null, alt: string | null, width: number | null = null, ctx = "") => {
    if (!raw) return;
    const url = upgradeImageUrl(raw);
    if (!IMG_EXT.test(url) && !/\/(image|img|photo|media)s?\//i.test(url)) return;
    if (SKIP_IMG.test(url) || SKIP_IMG.test(alt ?? "")) return;
    if (/floor[-_ ]?plan|plano|planritning|\bplan\b/i.test(`${url} ${alt ?? ""} ${ctx}`)) {
      floorplans.set(url, { url, label: alt });
      return;
    }
    const prev = images.get(url);
    if (!prev || (width ?? 0) > (prev.width ?? 0)) images.set(url, { url, alt, width });
  };
  for (const im of [].concat(listing?.image ?? [])) addImg(absolutize(typeof im === "string" ? im : (im as any)?.url, url), null);
  addImg(absolutize(meta($, "og:image"), url), null);
  $("img, source").each((_, el) => {
    const e = $(el);
    const ctx = e.closest("[class*='plan' i], [id*='plan' i]").length ? "plan" : "";
    const best = largestFromSrcset(e.attr("srcset") ?? e.attr("data-srcset") ?? e.attr("data-lazy-srcset"), url);
    const width = Number(e.attr("width")) || null;
    if (width !== null && width < 120 && !best) return; // icons
    const alt = e.attr("alt")?.trim() || e.attr("title")?.trim() || null;
    for (const a of ["data-full", "data-large", "data-original", "data-zoom-image", "data-lazy-src", "data-src", "src"]) {
      const v = absolutize(e.attr(a), url);
      if (v) {
        addImg(v, alt, width, ctx);
        break;
      }
    }
    if (best) addImg(best.url, alt, best.width, ctx);
  });
  // lightbox links point at full-size originals
  $("a[href]").each((_, el) => {
    const href = absolutize($(el).attr("href"), url);
    if (href && IMG_EXT.test(href)) addImg(href, $(el).attr("title") ?? $(el).find("img").attr("alt") ?? null, null, $(el).closest("[class*='plan' i]").length ? "plan" : "");
    if (href && /\.pdf(\?|$)/i.test(href) && /plan|plano|floor/i.test(`${href} ${$(el).text()}`)) floorplans.set(href, { url: href, label: $(el).text().trim() || null });
  });
  // background images in inline styles (sliders)
  $("[style*='background']").each((_, el) => {
    const m = ($(el).attr("style") ?? "").match(/url\((['"]?)(.*?)\1\)/);
    if (m) addImg(absolutize(m[2], url), null);
  });
  for (const u of extraImageUrls) addImg(u, null);

  // videos
  const videos = new Map<string, { url: string; kind: "file" | "youtube" | "vimeo" | "other" }>();
  $("video source[src], video[src]").each((_, el) => {
    const v = absolutize($(el).attr("src"), url);
    if (v) videos.set(v, { url: v, kind: "file" });
  });
  $("iframe[src], a[href]").each((_, el) => {
    const v = absolutize($(el).attr("src") ?? $(el).attr("href"), url);
    if (!v) return;
    if (/youtube\.com\/(embed|watch)|youtu\.be\//.test(v)) videos.set(v, { url: v, kind: "youtube" });
    else if (/player\.vimeo\.com|vimeo\.com\/\d+/.test(v)) videos.set(v, { url: v, kind: "vimeo" });
    else if (/\.(mp4|mov|webm)(\?|$)/i.test(v)) videos.set(v, { url: v, kind: "file" });
  });

  const features = $('[class*="feature" i] li, [class*="amenit" i] li')
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((t) => t && t.length < 60)
    .slice(0, 60);

  const reference = findLV(lv, /^(ref(erence)?|ref\.?|property id|listing id|referencia)$/);

  return {
    sourceUrl: url,
    adapter: "generic",
    title: title.replace(/\s+/g, " ").trim().slice(0, 200),
    price,
    currency,
    priceText,
    location: location?.slice(0, 200) ?? null,
    lat,
    lng,
    bedrooms: bedrooms != null ? Math.round(Number(bedrooms)) : null,
    bathrooms: bathrooms != null ? Math.round(Number(bathrooms)) : null,
    sqm,
    floors: floors != null && floors > 0 && floors < 80 ? Math.round(floors) : null,
    description: description?.slice(0, 4000) ?? null,
    images: [...images.values()].slice(0, 120),
    floorplans: [...floorplans.values()].slice(0, 20),
    videos: [...videos.values()].slice(0, 10),
    features: [...new Set(features)],
    reference,
  };
}
