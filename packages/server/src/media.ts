import { createHash } from "node:crypto";
import sharp from "sharp";
import { one } from "./db.js";
import { putObject } from "./s3.js";

const extFor = (ct: string, url: string) =>
  /png/.test(ct) ? "png" : /webp/.test(ct) ? "webp" : /avif/.test(ct) ? "avif" : /pdf/.test(ct) || /\.pdf/i.test(url) ? "pdf" : /mp4|quicktime|video/.test(ct) ? "mp4" : "jpg";

/** Store an uploaded/downloaded media file (dedup by sha256, thumbnail for images). Returns media id or null if rejected. */
export async function storeMedia(
  propertyId: string,
  buf: Buffer,
  contentType: string,
  o: { sourceUrl?: string | null; kind: "image" | "pdf" | "video" | "floorplan" | "frame"; alt?: string | null; sort?: number; parentId?: string | null; classification?: unknown },
): Promise<string | null> {
  const sha = createHash("sha256").update(buf).digest("hex");
  const existing = await one<{ id: string }>("select id from media_assets where property_id=$1 and sha256=$2", [propertyId, sha]);
  if (existing) return existing.id;
  const ext = extFor(contentType, o.sourceUrl ?? "");
  let width: number | null = null,
    height: number | null = null,
    thumbKey: string | null = null;
  let kind = o.kind;
  if (ext === "pdf") kind = "pdf";
  else if (ext === "mp4") kind = "video";
  const key = `properties/${propertyId}/media/${sha.slice(0, 20)}.${ext}`;
  if (kind === "image" || kind === "floorplan" || kind === "frame") {
    const meta = await sharp(buf, { failOn: "none" }).metadata();
    width = meta.width ?? null;
    height = meta.height ?? null;
    if (!width || !height) return null;
    if (Math.max(width, height) < 320) return null; // icons, thumbnails
    const thumb = await sharp(buf, { failOn: "none" }).rotate().resize({ width: 480, height: 480, fit: "inside" }).webp({ quality: 78 }).toBuffer();
    thumbKey = `properties/${propertyId}/thumbs/${sha.slice(0, 20)}.webp`;
    await putObject(thumbKey, thumb, "image/webp");
  }
  await putObject(key, buf, contentType || (ext === "pdf" ? "application/pdf" : ext === "mp4" ? "video/mp4" : `image/${ext}`));
  const row = await one<{ id: string }>(
    `insert into media_assets(property_id, kind, source_url, s3_key, thumb_key, content_type, width, height, bytes, sha256, sort, parent_id, classification)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (property_id, sha256) where sha256 is not null do nothing returning id`,
    [
      propertyId,
      kind,
      o.sourceUrl ?? null,
      key,
      thumbKey,
      contentType,
      width,
      height,
      buf.length,
      sha,
      o.sort ?? 0,
      o.parentId ?? null,
      o.classification ? JSON.stringify(o.classification) : o.alt ? JSON.stringify({ alt: o.alt }) : null,
    ],
  );
  return row?.id ?? null;
}

