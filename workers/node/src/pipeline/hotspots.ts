import { polygonCentroid, type PlanSpec } from "@pv/shared";
import { q } from "@pv/server";

const fmtPrice = (p: any) =>
  p.price ? new Intl.NumberFormat("en-GB", { style: "currency", currency: p.currency || "EUR", maximumFractionDigits: 0 }).format(p.price) : p.price_text;

/** (Re)generate automatic hotspots: rooms, price/availability, views and amenities. Manual hotspots are kept. */
export async function buildHotspots(property: any, floors: { id: string; level: number; elevation_m: number; plan_spec: PlanSpec | null }[]) {
  await q("delete from hotspots where property_id=$1 and auto", [property.id]);
  const rooms = await q("select * from rooms where floor_id = any($1::uuid[])", [floors.map((f) => f.id)]);
  const media = await q("select classification from media_assets where property_id=$1 and classification is not null", [property.id]);
  const classes = media.map((m) => m.classification ?? {});
  const hasView = classes.some((c) => c.class === "view");
  const amenities = [...new Set(classes.filter((c) => c.class === "amenity" && c.amenity).map((c) => c.amenity as string))];

  const insert = (floorId: string | null, roomId: string | null, kind: string, pos: number[], title: string, body: string | null) =>
    q("insert into hotspots(property_id, floor_id, room_id, kind, position, title, body, auto) values ($1,$2,$3,$4,$5,$6,$7,true)", [
      property.id,
      floorId,
      roomId,
      kind,
      JSON.stringify(pos),
      title,
      body,
    ]);

  for (const f of floors) {
    const plan = f.plan_spec;
    if (!plan) continue;
    for (const r of plan.rooms) {
      if (["stairs", "storage"].includes(r.type) || r.areaM2 < 3) continue;
      const [x, z] = polygonCentroid(r.polygon);
      const row = rooms.find((x) => x.floor_id === f.id && x.plan_room_id === r.id);
      const mat = r.materials?.floor ? `${r.materials.floor.kind} floor` : null;
      await insert(f.id, row?.id ?? null, "room", [x, f.elevation_m + 1.4, z], r.name, [`${r.areaM2} m²`, mat].filter(Boolean).join(" · "));
    }
  }
  const ground = floors[0]?.plan_spec;
  if (ground) {
    const living = ground.rooms.find((r) => r.type === "living") ?? ground.rooms[0];
    if (living) {
      const [x, z] = polygonCentroid(living.polygon);
      const price = fmtPrice(property);
      if (price) await insert(floors[0].id, null, "price", [x + 0.8, floors[0].elevation_m + 2.0, z], price, property.availability ?? "Available");
      if (hasView) {
        const top = floors[floors.length - 1];
        const lr = top.plan_spec!.rooms.find((r) => ["terrace", "balcony", "living", "bedroom"].includes(r.type)) ?? top.plan_spec!.rooms[0];
        const [vx, vz] = polygonCentroid(lr.polygon);
        await insert(top.id, null, "view", [vx, top.elevation_m + 1.7, vz], "Views", "See the view photos in the gallery");
      }
    }
    // amenities outside the footprint (positions are indicative)
    const xs = ground.walls.flatMap((w) => [w.a[0], w.b[0]]);
    const zs = ground.walls.flatMap((w) => [w.a[1], w.b[1]]);
    amenities.forEach((a, i) => {
      void insert(null, null, "amenity", [Math.min(...xs) + 2 + i * 3, 0.6, Math.min(...zs) - 3], a.charAt(0).toUpperCase() + a.slice(1), "Location indicative");
    });
  }
}
