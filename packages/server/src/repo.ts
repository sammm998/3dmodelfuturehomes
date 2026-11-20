import { AgencyTheme, PlanSpec, slugify } from "@pv/shared";
import { one, q } from "./db.js";
import { fileUrl } from "./s3.js";

export async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base);
  let slug = root;
  for (let i = 2; await one("select 1 from properties where slug=$1", [slug]); i++) slug = `${root}-${i}`;
  return slug;
}

/** Full property tree as the viewer and admin consume it. */
export async function propertyTree(where: { id?: string; slug?: string }) {
  const p = where.id
    ? await one("select * from properties where id=$1", [where.id])
    : await one("select * from properties where slug=$1", [where.slug]);
  if (!p) return null;
  const agency = p.agency_id ? await one("select * from agencies where id=$1", [p.agency_id]) : null;
  const buildings = await q("select * from buildings where property_id=$1 order by name", [p.id]);
  const bIds = buildings.map((b) => b.id);
  const floors = bIds.length
    ? await q("select * from floors where building_id = any($1::uuid[]) order by level", [bIds])
    : [];
  const fIds = floors.map((f) => f.id);
  const rooms = fIds.length ? await q("select * from rooms where floor_id = any($1::uuid[])", [fIds]) : [];
  const units = fIds.length ? await q("select * from units where floor_id = any($1::uuid[])", [fIds]) : [];
  const media = await q("select * from media_assets where property_id=$1 order by sort, created_at", [p.id]);
  const artifacts = await q("select * from artifacts where property_id=$1 order by created_at", [p.id]);
  const hotspots = await q("select * from hotspots where property_id=$1", [p.id]);

  const mediaOut = media.map((m) => ({
    id: m.id,
    kind: m.kind,
    url: fileUrl(m.s3_key),
    thumbUrl: fileUrl(m.thumb_key ?? m.s3_key),
    sourceUrl: m.source_url,
    width: m.width,
    height: m.height,
    classification: m.classification,
    confidence: m.class_confidence,
    floorId: m.floor_id,
    roomId: m.room_id,
    parentId: m.parent_id,
  }));
  const art = (ownerId: string) =>
    artifacts
      .filter((a) => a.owner_id === ownerId)
      .map((a) => ({ id: a.id, kind: a.kind, url: fileUrl(a.s3_key), provider: a.provider, provenance: a.provenance, meta: a.meta }));

  const theme = AgencyTheme.parse(agency?.theme ?? {});
  return {
    id: p.id,
    slug: p.slug,
    status: p.status,
    title: p.title,
    price: p.price,
    currency: p.currency,
    priceText: p.price_text,
    location: p.location,
    lat: p.lat,
    lng: p.lng,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    sqm: p.sqm,
    availability: p.availability,
    description: p.description,
    features: p.features,
    reference: p.reference,
    sourceUrl: p.source_url,
    sourceAdapter: p.source_adapter,
    createdAt: p.created_at,
    publishedAt: p.published_at,
    agency: agency
      ? {
          id: agency.id,
          slug: agency.slug,
          name: agency.name,
          theme: { ...theme, logoUrl: theme.logoUrl },
          whatsapp: agency.whatsapp,
          bookingUrl: agency.booking_url,
          website: agency.website,
        }
      : null,
    buildings: buildings.map((b) => ({
      id: b.id,
      name: b.name,
      floorsCount: b.floors_count,
      unitFloorIndex: b.unit_floor_index,
      massing: b.massing,
      artifacts: art(b.id),
      floors: floors
        .filter((f) => f.building_id === b.id)
        .map((f) => ({
          id: f.id,
          level: f.level,
          name: f.name,
          elevation: f.elevation_m,
          planStatus: f.plan_status,
          plan: f.plan_spec ? PlanSpec.parse(f.plan_spec) : null,
          sourceMediaId: f.source_media_id,
          artifacts: art(f.id),
          units: units.filter((u) => u.floor_id === f.id),
          rooms: rooms
            .filter((r) => r.floor_id === f.id)
            .map((r) => ({
              id: r.id,
              planRoomId: r.plan_room_id,
              name: r.name,
              type: r.type,
              sqm: r.sqm,
              materials: r.materials,
              bestLayer: r.best_layer,
              artifacts: art(r.id),
              mediaIds: media.filter((m) => m.room_id === r.id).map((m) => m.id),
            })),
        })),
    })),
    media: mediaOut,
    artifacts: art(p.id),
    hotspots: hotspots.map((h) => ({
      id: h.id,
      floorId: h.floor_id,
      roomId: h.room_id,
      kind: h.kind,
      position: h.position,
      title: h.title,
      body: h.body,
    })),
  };
}
export type PropertyTree = NonNullable<Awaited<ReturnType<typeof propertyTree>>>;

/** Keep the rooms table in sync with a floor's PlanSpec (room ids are the plan's ids). */
export async function syncRooms(floorId: string, plan: PlanSpec) {
  const ids = plan.rooms.map((r) => r.id);
  await q("delete from rooms where floor_id=$1 and not (plan_room_id = any($2::text[]))", [floorId, ids]);
  for (const r of plan.rooms) {
    await q(
      `insert into rooms(floor_id, plan_room_id, type, name, sqm, materials) values ($1,$2,$3,$4,$5,$6)
       on conflict (floor_id, plan_room_id) do update set type=excluded.type, name=excluded.name, sqm=excluded.sqm,
         materials = case when excluded.materials = '{}'::jsonb then rooms.materials else excluded.materials end`,
      [floorId, r.id, r.type, r.name, r.areaM2, JSON.stringify(r.materials ?? {})],
    );
  }
}
