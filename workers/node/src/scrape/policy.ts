import robotsParser from "robots-parser";
import { env, one } from "@pv/server";
import type { Redis } from "ioredis";

export class ScrapeNotAllowed extends Error {}

/** Domain is only scraped if an admin confirmed we have the right to use its content. */
export async function assertDomainAllowed(url: string) {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const src = await one<{ rights_confirmed: boolean; rate_limit_ms: number; adapter: string }>(
    "select rights_confirmed, rate_limit_ms, adapter from scrape_sources where domain=$1 or domain=$2",
    [host, `www.${host}`],
  );
  if (!src || !src.rights_confirmed)
    throw new ScrapeNotAllowed(
      `Import from ${host} is not enabled. An admin must confirm content rights for this domain (Admin → Sources).`,
    );
  return src;
}

const robotsCache = new Map<string, { at: number; robots: ReturnType<typeof robotsParser> | null }>();

export async function robotsAllows(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > 3600_000) {
    const robotsUrl = `${u.origin}/robots.txt`;
    let robots: ReturnType<typeof robotsParser> | null = null;
    try {
      const r = await fetchImpl(robotsUrl, { headers: { "user-agent": env.userAgent }, signal: AbortSignal.timeout(15000) });
      if (r.ok) robots = robotsParser(robotsUrl, await r.text());
      else if (r.status >= 500) throw new Error(`robots.txt ${r.status}`); // server error: be conservative
    } catch (e) {
      // network error / 5xx: treat as disallow (RFC 9309 §2.3.1.4)
      robotsCache.set(key, { at: Date.now(), robots: robotsParser(robotsUrl, "User-agent: *\nDisallow: /") });
      throw new ScrapeNotAllowed(`robots.txt for ${u.host} could not be fetched (${(e as Error).message}); not scraping.`);
    }
    entry = { at: Date.now(), robots };
    robotsCache.set(key, entry);
  }
  if (!entry.robots) return true; // 4xx: no robots.txt -> allowed
  return entry.robots.isAllowed(url, env.userAgent) !== false;
}

/** Per-domain politeness delay shared across all worker processes (Redis). */
export async function throttle(redis: Redis, url: string, minIntervalMs: number) {
  const host = new URL(url).hostname;
  const key = `throttle:${host}`;
  for (;;) {
    const ok = await redis.set(key, "1", "PX", minIntervalMs, "NX");
    if (ok) return;
    const ttl = await redis.pttl(key);
    await new Promise((r) => setTimeout(r, Math.max(50, ttl)));
  }
}
