import { env, q, storeMedia } from "@pv/server";
import type { Redis } from "ioredis";
import { throttle } from "../scrape/policy.js";

const MAX_BYTES = 60 * 1024 * 1024;

export interface IngestItem {
  url: string;
  kind: "image" | "pdf" | "video" | "floorplan";
  alt: string | null;
  sort: number;
}

/** Download one remote media file politely and store it (dedup by sha256). Returns media id or null. */
export async function ingestRemote(redis: Redis, propertyId: string, item: IngestItem, rateMs: number): Promise<string | null> {
  await throttle(redis, item.url, rateMs);
  const res = await fetch(item.url, { headers: { "user-agent": env.userAgent, referer: new URL(item.url).origin }, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${item.url}`);
  const ct = res.headers.get("content-type") ?? "";
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error(`file too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  return storeMedia(propertyId, buf, ct, { sourceUrl: item.url, kind: item.kind, alt: item.alt, sort: item.sort });
}

export async function mediaOf(propertyId: string, kinds: string[]) {
  return q("select * from media_assets where property_id=$1 and kind = any($2::text[]) order by sort, created_at", [propertyId, kinds]);
}
