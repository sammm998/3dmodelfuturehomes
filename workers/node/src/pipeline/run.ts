import {
  generateIllustrativePlans,
  PlanSpec,
  type PipelineStepKey,
  type PlanSpec as PlanSpecT,
} from "@pv/shared";
import {
  finishJob,
  getObject,
  one,
  putObject,
  q,
  runPy,
  setStep,
  syncRooms,
  fileUrl,
  connection,
  storeMedia,
  uniqueSlug,
} from "@pv/server";
import { createVisionProvider, type FloorplanSemantics } from "@pv/vision";
import type { Redis } from "ioredis";
import { scrapeListing } from "../scrape/browser.js";
import { assertDomainAllowed, robotsAllows, ScrapeNotAllowed, throttle } from "../scrape/policy.js";
import { buildHotspots } from "./hotspots.js";
import { ingestRemote, mediaOf } from "./ingest.js";
import { optimizeGlb } from "./optimize.js";

export interface PipelineJob {
  jobId: string;
  propertyId: string;
  mode: "url" | "upload" | "rebake" | "reprocess";
  url?: string;
}

const vision = createVisionProvider();
let redis: Redis | null = null;
const r = () => (redis ??= connection());

async function pMap<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

const fileHint = (m: any) => [m.source_url?.split("/").pop(), m.classification?.alt].filter(Boolean).join(" ");

export async function runPipeline(job: PipelineJob) {
  const { jobId, propertyId } = job;
  const step = async (key: PipelineStepKey, fn: () => Promise<string | null | void>) => {
    await setStep(jobId, key, "running");
    try {
      const msg = await fn();
      await setStep(jobId, key, msg && msg.startsWith("skipped:") ? "skipped" : "done", msg ? msg.replace(/^skipped:\s*/, "") : null);
    } catch (e) {
      await setStep(jobId, key, "failed", (e as Error).message.slice(0, 400));
      throw e;
    }
  };

  try {
    await q("update properties set status='processing', updated_at=now() where id=$1", [propertyId]);
    const rebakeOnly = job.mode === "rebake";

    // 1. fetch -------------------------------------------------------------
    let listingMedia: { url: string; kind: "image" | "pdf" | "video" | "floorplan"; alt: string | null; sort: number }[] = [];
    let rateMs = 2500;
    if (job.mode === "url" && job.url) {
      await step("fetch", async () => {
        const src = await assertDomainAllowed(job.url!);
        rateMs = src.rate_limit_ms;
        if (!(await robotsAllows(job.url!))) throw new ScrapeNotAllowed(`robots.txt disallows ${job.url}`);
        await throttle(r(), job.url!, rateMs);
        const { listing } = await scrapeListing(job.url!);
        await q(
          `update properties set title=$2, price=$3, currency=$4, price_text=$5, location=$6, lat=$7, lng=$8, bedrooms=$9, bathrooms=$10,
             sqm=$11, description=$12, features=$13, reference=$14, raw=$15, source_adapter=$16, updated_at=now() where id=$1`,
          [
            propertyId, listing.title, listing.price, listing.currency, listing.priceText, listing.location, listing.lat, listing.lng,
            listing.bedrooms, listing.bathrooms, listing.sqm, listing.description, JSON.stringify(listing.features), listing.reference,
            JSON.stringify(listing), listing.adapter,
          ],
        );
        // the slug was derived from the URL at import time; use the real title now (no public links exist yet)
        const cur = await one("select slug, published_at from properties where id=$1", [propertyId]);
        if (!cur.published_at && job.mode === "url") {
          await q("update properties set slug=$2 where id=$1", [propertyId, await uniqueSlug(listing.title)]);
        }
        listingMedia = [
          ...listing.images.map((i, k) => ({ url: i.url, kind: "image" as const, alt: i.alt, sort: k })),
          ...listing.floorplans.map((f, k) => ({ url: f.url, kind: (/\.pdf/i.test(f.url) ? "pdf" : "floorplan") as "pdf" | "floorplan", alt: f.label ?? "floor plan", sort: 1000 + k })),
          ...listing.videos.filter((v) => v.kind === "file").map((v, k) => ({ url: v.url, kind: "video" as const, alt: null, sort: 2000 + k })),
        ];
        return `${listing.title}: ${listing.images.length} images, ${listing.floorplans.length} floor plans, ${listing.videos.length} videos (adapter: ${listing.adapter})`;
      });
    } else await setStep(jobId, "fetch", "skipped", job.mode === "upload" ? "uploaded media" : null);

    const property = await one("select * from properties where id=$1", [propertyId]);

    if (!rebakeOnly) {
      // 2. ingest -----------------------------------------------------------
      await step("ingest", async () => {
        let ok = 0,
          failed = 0;
        await pMap(listingMedia.slice(0, 90), 3, async (item) => {
          try {
            if (await ingestRemote(r(), propertyId, item, rateMs)) ok++;
          } catch (e) {
            failed++;
            console.warn("[ingest]", (e as Error).message);
          }
        });
        // expand PDFs into page images and videos into keyframes
        let pages = 0,
          frames = 0;
        for (const pdf of await mediaOf(propertyId, ["pdf"])) {
          const done = await one("select 1 from media_assets where parent_id=$1 limit 1", [pdf.id]);
          if (done) continue;
          const res = await runPy<{ pages: string[] }>("pdf.rasterize", { key: pdf.s3_key, prefix: `properties/${propertyId}/pdf/${pdf.id}` });
          for (const [i, key] of res.pages.entries()) {
            const buf = await getObject(key);
            if (await storeMedia(propertyId, buf, "image/png", { kind: "image", sourceUrl: pdf.source_url, alt: `floor plan page ${i + 1}`, sort: 1500 + i, parentId: pdf.id })) pages++;
          }
        }
        for (const v of await mediaOf(propertyId, ["video"])) {
          const done = await one("select 1 from media_assets where parent_id=$1 limit 1", [v.id]);
          if (done) continue;
          const res = await runPy<{ frames: string[] }>("video.keyframes", { key: v.s3_key, prefix: `properties/${propertyId}/frames/${v.id}`, maxFrames: 24 });
          for (const key of res.frames) {
            const buf = await getObject(key);
            if (await storeMedia(propertyId, buf, "image/jpeg", { kind: "frame", sourceUrl: v.source_url, sort: 3000 + frames, parentId: v.id })) frames++;
          }
        }
        const total = await one<{ n: number }>("select count(*)::int n from media_assets where property_id=$1", [propertyId]);
        return `${total?.n ?? 0} media files (${ok} downloaded${failed ? `, ${failed} failed` : ""}, ${pages} PDF pages, ${frames} video frames)`;
      });

      // 3. classify ---------------------------------------------------------
      await step("classify", async () => {
        const items = (await mediaOf(propertyId, ["image", "floorplan", "frame"])).filter((m) => !m.classification?.class);
        const counts: Record<string, number> = {};
        await pMap(items, 4, async (m) => {
          const data = await getObject(m.s3_key);
          const hint = `${fileHint(m)} ${m.kind === "floorplan" ? "floor plan" : ""}`.trim();
          const c = await vision.classify({ data, hint });
          // the scraper already knows some items are plans; keep that if the model is unsure
          const cls = m.kind === "floorplan" && c.class !== "floorplan" && c.confidence < 0.8 ? { ...c, class: "floorplan" as const } : c;
          counts[cls.class] = (counts[cls.class] ?? 0) + 1;
          await q("update media_assets set classification=coalesce(classification,'{}'::jsonb) || $2::jsonb, class_confidence=$3, kind=case when $4 then 'floorplan' else kind end where id=$1", [
            m.id,
            JSON.stringify(cls),
            cls.confidence,
            cls.class === "floorplan" && m.kind !== "frame",
          ]);
        });
        return `${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing new"} (${vision.name}${vision.degraded ? `, ${vision.degraded} fallbacks` : ""})`;
      });

      // 4. structure --------------------------------------------------------
      await step("structure", async () => {
        const plans = (await mediaOf(propertyId, ["floorplan", "image"])).filter((m) => m.classification?.class === "floorplan");
        // semantic reading of each plan (level, labels, printed areas)
        const sem: { media: any; s: FloorplanSemantics }[] = [];
        for (const m of plans.slice(0, 8)) {
          const s = await vision.analyzeFloorplan({ data: await getObject(m.s3_key), hint: fileHint(m) });
          if (!s.isFloorplan) continue;
          await q("update media_assets set classification = classification || $2::jsonb where id=$1", [m.id, JSON.stringify({ semantics: s })]);
          sem.push({ media: m, s });
        }
        // pick one plan per level (largest image wins), ordered by level
        const byLevel = new Map<number, { media: any; s: FloorplanSemantics }>();
        sem.forEach((x, i) => {
          const lvl = x.s.levelIndex ?? i;
          const prev = byLevel.get(lvl);
          if (!prev || (x.media.width ?? 0) * (x.media.height ?? 0) > (prev.media.width ?? 0) * (prev.media.height ?? 0)) byLevel.set(lvl, x);
        });
        const levels = [...byLevel.entries()].sort((a, b) => a[0] - b[0]);
        const prop = await one("select * from properties where id=$1", [propertyId]);
        const raw = prop.raw ?? {};
        const isVilla = /villa|house|chalet|townhouse|detached|semi|bungalow/i.test(`${prop.title} ${prop.description ?? ""}`);
        const guessFloors = raw.floors ?? (isVilla && (prop.sqm ?? 0) > 170 && (prop.bedrooms ?? 0) >= 3 ? 2 : 1);

        await q("delete from buildings where property_id=$1", [propertyId]);
        const b = await one<{ id: string }>("insert into buildings(property_id, name, floors_count) values ($1,'Main building',$2) returning id", [
          propertyId,
          Math.max(levels.length, guessFloors),
        ]);
        if (levels.length) {
          for (const [i, [, x]] of levels.entries()) {
            const name = x.s.levelHint ?? (i === 0 ? "Ground floor" : `Floor ${i}`);
            await q("insert into floors(building_id, level, name, source_media_id, plan_status) values ($1,$2,$3,$4,'missing')", [b!.id, i, name, x.media.id]);
            await q("update media_assets set floor_id=(select id from floors where building_id=$1 and level=$2) where id=$3", [b!.id, i, x.media.id]);
          }
          return `${levels.length} floor plan(s) found → ${levels.length} floor(s)`;
        }
        const gen = generateIllustrativePlans({ sqm: prop.sqm, bedrooms: prop.bedrooms, bathrooms: prop.bathrooms, floors: guessFloors });
        for (const [i, plan] of gen.entries()) {
          await q("insert into floors(building_id, level, name, plan_spec, plan_status) values ($1,$2,$3,$4,'generated')", [
            b!.id,
            i,
            i === 0 ? "Ground floor" : `Floor ${i}`,
            JSON.stringify(plan),
          ]);
        }
        return `no floor plan found: generated an ILLUSTRATIVE layout (${gen.length} floor(s)) from listing data`;
      });
    }

    const floorsQ = () =>
      q(
        `select f.* from floors f join buildings b on b.id=f.building_id where b.property_id=$1 order by f.level`,
        [propertyId],
      );

    if (!rebakeOnly) {
      // 5. floor plan parsing ----------------------------------------------
      await step("floorplan", async () => {
        const floors = await floorsQ();
        const msgs: string[] = [];
        for (const f of floors) {
          if (!f.source_media_id || (f.plan_spec && ["edited", "authored"].includes(f.plan_status))) {
            if (f.plan_spec) await syncRooms(f.id, PlanSpec.parse(f.plan_spec));
            continue;
          }
          const m = await one("select * from media_assets where id=$1", [f.source_media_id]);
          const s: FloorplanSemantics | undefined = m.classification?.semantics;
          const singleFloor = floors.length === 1;
          try {
            const { plan } = await runPy<{ plan: any }>("floorplan.parse", {
              key: m.s3_key,
              hints: {
                totalAreaM2: s?.totalAreaM2 ?? null,
                listingSqm: singleFloor ? property.sqm : property.sqm ? property.sqm / floors.length : null,
                rooms: s?.rooms ?? [],
                ceilingHeightM: s?.ceilingHeightM ?? null,
              },
            });
            delete plan.debug;
            plan.underlay = { ...plan.underlay, mediaId: m.id, url: fileUrl(m.s3_key) };
            const spec = PlanSpec.parse(plan);
            await q("update floors set plan_spec=$2, plan_status=$3 where id=$1", [f.id, JSON.stringify(spec), spec.confidence < 0.6 ? "needs_review" : "parsed"]);
            await syncRooms(f.id, spec);
            msgs.push(`${f.name}: ${spec.rooms.length} rooms, ${spec.walls.length} walls (confidence ${spec.confidence}, scale from ${spec.scale.source})`);
          } catch (e) {
            const [gen] = generateIllustrativePlans({ sqm: property.sqm ? property.sqm / floors.length : null, bedrooms: property.bedrooms, bathrooms: property.bathrooms });
            await q("update floors set plan_spec=$2, plan_status='needs_review' where id=$1", [f.id, JSON.stringify(gen)]);
            await syncRooms(f.id, gen);
            msgs.push(`${f.name}: parsing failed (${(e as Error).message}); illustrative layout used, please edit`);
          }
        }
        for (const f of floors) if (f.plan_spec && !f.source_media_id) msgs.push(`${f.name}: ${f.plan_status} layout`);
        // stack elevations
        let y = 0;
        for (const f of await floorsQ()) {
          await q("update floors set elevation_m=$2 where id=$1", [f.id, y]);
          const p = f.plan_spec as PlanSpecT | null;
          y += (p?.ceilingHeight ?? 2.7) + (p?.slabThickness ?? 0.25);
        }
        return msgs.join(" · ") || "no plans";
      });

      // 6. match photos to rooms -------------------------------------------
      await step("match", async () => {
        const rooms = await q(
          `select r.*, f.name as floor_name from rooms r join floors f on f.id=r.floor_id join buildings b on b.id=f.building_id where b.property_id=$1`,
          [propertyId],
        );
        if (!rooms.length) return "skipped: no rooms";
        const photos = (await mediaOf(propertyId, ["image", "frame"])).filter((m) => m.classification?.class === "interior");
        const list = rooms.map((x, i) => ({ id: `r${i}`, name: `${x.name} (${x.floor_name})`, type: x.type }));
        let matched = 0;
        await pMap(photos.slice(0, 60), 4, async (m) => {
          const res = await vision.matchRoom({ data: await getObject(m.s3_key), hint: fileHint(m) }, list);
          const idx = res.roomId ? Number(res.roomId.slice(1)) : -1;
          const room = rooms[idx];
          if (room && res.confidence >= 0.35) {
            matched++;
            await q("update media_assets set room_id=$2, floor_id=$3 where id=$1", [m.id, room.id, room.floor_id]);
          }
        });
        return `${matched}/${photos.length} interior photos matched to rooms`;
      });

      // 7. materials -------------------------------------------------------
      await step("materials", async () => {
        const floors = await floorsQ();
        const rooms = await q("select * from rooms where floor_id = any($1::uuid[])", [floors.map((f) => f.id)]);
        const photosByRoom = new Map<string, any[]>();
        for (const m of await q("select * from media_assets where property_id=$1 and room_id is not null", [propertyId])) {
          photosByRoom.set(m.room_id, [...(photosByRoom.get(m.room_id) ?? []), m]);
        }
        const found: Record<string, { kind: string; color: string; wall: string }> = {};
        for (const room of rooms) {
          const ph = photosByRoom.get(room.id)?.[0];
          if (!ph) continue;
          const mat = await vision.materials({ data: await getObject(ph.s3_key), hint: fileHint(ph) });
          found[room.id] = { kind: mat.floor.kind === "unknown" ? "stone" : mat.floor.kind, color: mat.floor.colorHex, wall: mat.wallColorHex };
        }
        // rooms without photos inherit the dominant finish of photographed rooms of a similar kind
        const wet = (t: string) => ["bathroom", "wc", "laundry"].includes(t);
        const outdoor = (t: string) => ["terrace", "balcony"].includes(t);
        const defaults = (t: string) => {
          const similar = rooms.find((x) => found[x.id] && wet(x.type) === wet(t) && outdoor(x.type) === outdoor(t));
          if (similar) return found[similar.id];
          if (wet(t)) return { kind: "tile", color: "#d8d3ca", wall: "#f4f1ec" };
          if (outdoor(t)) return { kind: "stone", color: "#cfc6b4", wall: "#f4f1ec" };
          return { kind: "wood", color: "#b58a60", wall: "#f3f0ea" };
        };
        const items = rooms.map((room) => {
          const f = found[room.id] ?? defaults(room.type);
          return { id: room.id, kind: f.kind, color: f.color, wall: f.wall, fromPhoto: !!found[room.id] };
        });
        const uniq = [...new Map(items.map((i) => [`${i.kind}${i.color}`, i])).values()];
        const tex = await runPy<{ textures: Record<string, Record<string, string>> }>("textures.generate", {
          items: uniq.map((u) => ({ id: `${u.kind}-${u.color.slice(1)}`, kind: u.kind, color: u.color })),
          prefix: `properties/${propertyId}/textures`,
        });
        for (const f of floors) {
          const plan = f.plan_spec as PlanSpecT | null;
          if (!plan) continue;
          for (const pr of plan.rooms) {
            const room = rooms.find((x) => x.floor_id === f.id && x.plan_room_id === pr.id);
            const it = room && items.find((i) => i.id === room.id);
            if (!it) continue;
            const t = tex.textures[`${it.kind}-${it.color.slice(1)}`];
            pr.materials = {
              floor: { kind: it.kind as any, color: it.color, textureKey: t?.albedo, provenance: "illustrative" },
              walls: { color: it.wall, provenance: "illustrative" },
            };
            await q("update rooms set materials=$2 where id=$1", [room!.id, JSON.stringify({ ...pr.materials, textures: t, fromPhoto: it.fromPhoto })]);
          }
          await q("update floors set plan_spec=$2 where id=$1", [f.id, JSON.stringify(plan)]);
        }
        const fromPhotos = items.filter((i) => i.fromPhoto).length;
        return `${fromPhotos} rooms from photos, ${items.length - fromPhotos} inferred; ${uniq.length} PBR texture sets (illustrative)`;
      });

      // 8. panoramas -------------------------------------------------------
      await step("panorama", async () => {
        const rooms = await q(
          `select r.id, r.name, array_agg(m.s3_key order by m.sort) keys from rooms r join media_assets m on m.room_id=r.id
           where m.property_id=$1 group by r.id, r.name limit 14`,
          [propertyId],
        );
        if (!rooms.length) return "skipped: no room photos to build panoramas from";
        await q("delete from artifacts where property_id=$1 and kind='panorama'", [propertyId]);
        const prov: string[] = [];
        for (const room of rooms) {
          const key = `properties/${propertyId}/pano/${room.id}.jpg`;
          const res = await runPy<any>("panorama.build", { keys: room.keys.slice(0, 10), key });
          if (res.skipped) continue;
          await q("insert into artifacts(property_id, owner_type, owner_id, kind, s3_key, provider, provenance, meta) values ($1,'room',$2,'panorama',$3,$4,$5,$6)", [
            propertyId,
            room.id,
            key,
            res.provider,
            res.provenance,
            JSON.stringify(res.meta),
          ]);
          prov.push(res.provenance);
        }
        return `${prov.length} panoramas (${prov.filter((p) => p === "reconstructed").length} stitched, ${prov.filter((p) => p !== "reconstructed").length} illustrative)`;
      });

      // 9. gaussian splatting ----------------------------------------------
      await step("splat", async () => {
        const video = (await mediaOf(propertyId, ["video"]))[0];
        const imgs = (await mediaOf(propertyId, ["image"])).filter((m) => ["interior", "exterior"].includes(m.classification?.class));
        if (!video && imgs.length < 20) return "skipped: needs a walkthrough video or 20+ photos";
        const res = await runPy<any>(
          "splat.train",
          { videoKey: video?.s3_key ?? null, imageKeys: video ? [] : imgs.slice(0, 150).map((m) => m.s3_key), prefix: `properties/${propertyId}/splat` },
          4 * 3600_000,
        );
        if (res.skipped) return `skipped: ${res.skipped}`;
        await q("delete from artifacts where property_id=$1 and kind in ('splat','world')", [propertyId]);
        await q("insert into artifacts(property_id, owner_type, owner_id, kind, s3_key, provider, provenance, meta) values ($1,'property',$1,$2,$3,$4,$5,$6)", [
          propertyId,
          res.kind,
          res.key,
          res.provider,
          res.provenance,
          JSON.stringify({ format: res.format }),
        ]);
        return `${res.kind} via ${res.provider}`;
      });

      // 10. exterior -------------------------------------------------------
      await step("exterior", async () => {
        // most confident exterior photos first: they drive the facade
        const ext = (await mediaOf(propertyId, ["image"]))
          .filter((m) => m.classification?.class === "exterior")
          .sort((a, b) => (b.class_confidence ?? 0) - (a.class_confidence ?? 0))
          .slice(0, 4);
        const b = await one("select * from buildings where property_id=$1", [propertyId]);
        const floors = await floorsQ();
        let spec: any = null;
        if (ext.length) {
          spec = await vision.exteriorSpec(await Promise.all(ext.map(async (m) => ({ data: await getObject(m.s3_key), hint: fileHint(m) }))));
        }
        // whole houses: trust the photos for the storey count when no plan exists for some floors
        let floorsCount = b.floors_count;
        if (spec && b.unit_floor_index == null && spec.storeys > 0 && spec.confidence >= 0.5) floorsCount = Math.max(floors.length, Math.round(spec.storeys));
        await q("update buildings set floors_count=$2 where id=$1", [b.id, floorsCount]);
        const massing = {
          facadeColor: spec?.wallColor ?? "#efe9df",
          facadeFromPhoto: ext.length > 0,
          roof: spec?.roof ?? "flat",
          facade: spec,
          heroMediaId: ext[0]?.id ?? null,
          photoMediaIds: ext.map((m) => m.id),
          floorsCount,
          contextFloors: Math.max(0, floorsCount - floors.length),
          provenance: "illustrative",
        };
        await q("update buildings set massing=$2 where id=$1", [b.id, JSON.stringify(massing)]);
        let geo = "";
        if ((property.lat == null || property.lng == null) && property.location && process.env.MAPBOX_TOKEN) {
          const u = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(property.location)}&limit=1&access_token=${process.env.MAPBOX_TOKEN}`;
          const g = await fetch(u).then((x) => x.json()).catch(() => null);
          const c = g?.features?.[0]?.geometry?.coordinates;
          if (c) {
            await q("update properties set lat=$2, lng=$3 where id=$1", [propertyId, c[1], c[0]]);
            geo = ` · geocoded ${property.location}`;
          }
        }
        return spec
          ? `${spec.style}: ${spec.wallMaterial} ${spec.wallColor}, ${spec.roof} roof, ${spec.balconies !== "none" ? spec.balconies + " balconies, " : ""}${floorsCount} storeys (from ${ext.length} photos, ${vision.name}${spec.confidence < 0.5 ? ", low confidence" : ""})${geo}`
          : `no exterior photos: default facade, ${floorsCount} storeys${geo}`;
      });
    } else {
      for (const k of ["ingest", "classify", "structure", "floorplan", "match", "materials", "panorama", "splat", "exterior"] as const)
        await setStep(jobId, k, "skipped", "plan edit: only rebuilding 3D");
    }

    // 11. bake ---------------------------------------------------------------
    await step("bake", async () => {
      const floors = await floorsQ();
      const plans = floors.filter((f) => f.plan_spec).map((f) => f.plan_spec);
      if (!plans.length) return "skipped: no plans";
      const b = await one("select id from buildings where property_id=$1", [propertyId]);
      const raw = `properties/${propertyId}/shell/shell.glb`;
      const res = await runPy<{ key: string; bytes: number; provenance: string; provider: string }>("bake.glb", {
        plans,
        elevations: floors.filter((f) => f.plan_spec).map((f) => f.elevation_m),
        key: raw,
      });
      const optimized = await optimizeGlb(new Uint8Array(await getObject(raw)));
      const key = `properties/${propertyId}/shell/shell.draco.glb`;
      await putObject(key, Buffer.from(optimized), "model/gltf-binary");
      await q("delete from artifacts where property_id=$1 and kind='shell_glb'", [propertyId]);
      await q("insert into artifacts(property_id, owner_type, owner_id, kind, s3_key, bytes, provider, provenance, meta) values ($1,'building',$2,'shell_glb',$3,$4,$5,$6,$7)", [
        propertyId,
        b.id,
        key,
        optimized.byteLength,
        res.provider,
        res.provenance,
        JSON.stringify({ rawBytes: res.bytes, compression: "draco" }),
      ]);
      return `GLB ${(res.bytes / 1024).toFixed(0)} KB → ${(optimized.byteLength / 1024).toFixed(0)} KB (Draco)`;
    });

    // 12. hotspots ---------------------------------------------------------
    await step("hotspots", async () => {
      const p = await one("select * from properties where id=$1", [propertyId]);
      await buildHotspots(p, await floorsQ());
      const n = await one<{ n: number }>("select count(*)::int n from hotspots where property_id=$1", [propertyId]);
      return `${n?.n} hotspots`;
    });

    const autoPublish = process.env.AUTO_PUBLISH === "true";
    await q(
      `update properties set status = case when status='published' or $2 then 'published' else 'review' end,
         published_at = case when $2 and published_at is null then now() else published_at end, updated_at=now() where id=$1`,
      [propertyId, autoPublish],
    );
    // keep published properties published after a rebake
    await finishJob(jobId, "done");
  } catch (e) {
    console.error("[pipeline]", e);
    await q("update properties set status = case when published_at is not null then 'published' else 'failed' end, updated_at=now() where id=$1", [propertyId]);
    await finishJob(jobId, "failed", (e as Error).message);
    // mark remaining pending steps as skipped for a clear UI
    const job = await one("select steps from jobs where id=$1", [jobId]);
    for (const s of job?.steps ?? []) if (s.status === "pending") await setStep(jobId, s.key, "skipped", "not run (earlier step failed)");
  }
}
