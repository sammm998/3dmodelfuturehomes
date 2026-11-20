/**
 * Seed: Future Homes agency (white-label theme), scrape source settings and two DEMO properties
 * (fictional) so everything works locally without API keys or network access.
 *   - "Villa Serena (demo)": two-storey villa with authored floor plans
 *   - "Mar Azul Residences, Apt 2B (demo)": apartment on floor 2 of a 6-storey building (illustrative layout)
 * Re-running is safe: demo rows are replaced.
 */
import sharp from "sharp";
import { demoVillaPlans, generateIllustrativePlans, planBounds, type FacadeSpec, type PlanSpec } from "@pv/shared";
import {
  createJob,
  ensureBucket,
  initialSteps,
  migrate,
  one,
  pipelineQueue,
  pool,
  putObject,
  q,
  storeMedia,
  syncRooms,
  fileUrl,
} from "@pv/server";

const FH_THEME = {
  primary: "#1a365d",
  accent: "#c9a227",
  background: "#0b1526",
  text: "#ffffff",
  fontHeading: "'Playfair Display', Georgia, serif",
  fontBody: "Inter, system-ui, sans-serif",
  logoUrl: null,
};

/** Draw a PlanSpec as a floor-plan PNG (used as the editor underlay and as a "source" plan image). */
async function planPng(plan: PlanSpec, ppm = 60): Promise<{ png: Buffer; width: number; height: number; origin: [number, number] }> {
  const b = planBounds(plan);
  const m = 1.2;
  const W = Math.round((b.w + 2 * m) * ppm),
    H = Math.round((b.h + 2 * m) * ppm);
  const X = (x: number) => (x - b.minX + m) * ppm,
    Y = (y: number) => (y - b.minY + m) * ppm;
  const parts: string[] = [`<rect width="100%" height="100%" fill="#fff"/>`];
  for (const r of plan.rooms) {
    parts.push(`<polygon points="${r.polygon.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ")}" fill="#fafafa"/>`);
  }
  for (const w of plan.walls) {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const dx = (w.b[0] - w.a[0]) / L,
      dy = (w.b[1] - w.a[1]) / L;
    const ops = plan.openings.filter((o) => o.wallId === w.id).map((o) => [o.t * L - o.width / 2, o.t * L + o.width / 2, o] as const).sort((a, c) => a[0] - c[0]);
    let cur = 0;
    const seg = (s0: number, s1: number) => {
      const e0 = s0 === 0 ? -w.thickness / 2 : 0,
        e1 = s1 >= L - 1e-6 ? w.thickness / 2 : 0;
      parts.push(
        `<line x1="${X(w.a[0] + dx * (s0 + e0))}" y1="${Y(w.a[1] + dy * (s0 + e0))}" x2="${X(w.a[0] + dx * (s1 + e1))}" y2="${Y(w.a[1] + dy * (s1 + e1))}" stroke="#1d1d1d" stroke-width="${w.thickness * ppm}"/>`,
      );
    };
    for (const [s0, s1, o] of ops) {
      if (s0 > cur) seg(cur, s0);
      if (o.type === "window" || o.type === "sliding") {
        for (const off of [-0.3, 0.3]) {
          const nx = -dy * w.thickness * off,
            ny = dx * w.thickness * off;
          parts.push(
            `<line x1="${X(w.a[0] + dx * s0 + nx)}" y1="${Y(w.a[1] + dy * s0 + ny)}" x2="${X(w.a[0] + dx * s1 + nx)}" y2="${Y(w.a[1] + dy * s1 + ny)}" stroke="#333" stroke-width="1.2"/>`,
          );
        }
      }
      cur = s1;
    }
    if (cur < L) seg(cur, L);
  }
  for (const r of plan.rooms) {
    const cx = r.polygon.reduce((s, p) => s + p[0], 0) / r.polygon.length;
    const cy = r.polygon.reduce((s, p) => s + p[1], 0) / r.polygon.length;
    parts.push(
      `<text x="${X(cx)}" y="${Y(cy)}" font-family="Helvetica, Arial, sans-serif" font-size="${ppm * 0.22}" text-anchor="middle" fill="#333">${r.name.toUpperCase().replace(/&/g, "&amp;")}</text>`,
      `<text x="${X(cx)}" y="${Y(cy) + ppm * 0.3}" font-family="Helvetica, Arial, sans-serif" font-size="${ppm * 0.18}" text-anchor="middle" fill="#666">${r.areaM2} m²</text>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join("")}</svg>`;
  return { png: await sharp(Buffer.from(svg)).png().toBuffer(), width: W, height: H, origin: [b.minX - m, b.minY - m] };
}

const MATERIALS: Record<string, { kind: "wood" | "tile" | "stone"; color: string; wall: string }> = {
  living: { kind: "stone", color: "#d9cfbf", wall: "#f5f2ec" },
  kitchen: { kind: "stone", color: "#d9cfbf", wall: "#f5f2ec" },
  hall: { kind: "stone", color: "#d9cfbf", wall: "#f5f2ec" },
  stairs: { kind: "stone", color: "#d9cfbf", wall: "#f5f2ec" },
  bedroom: { kind: "wood", color: "#b48a62", wall: "#f3efe8" },
  bathroom: { kind: "tile", color: "#e3dfd8", wall: "#ece9e4" },
  wc: { kind: "tile", color: "#e3dfd8", wall: "#ece9e4" },
  storage: { kind: "stone", color: "#cfc6b6", wall: "#f3efe8" },
  other: { kind: "wood", color: "#b48a62", wall: "#f3efe8" },
};

function withMaterials(plan: PlanSpec): PlanSpec {
  return {
    ...plan,
    rooms: plan.rooms.map((r) => {
      const m = MATERIALS[r.type] ?? MATERIALS.other;
      return { ...r, materials: { floor: { kind: m.kind, color: m.color, provenance: "illustrative" }, walls: { color: m.wall, provenance: "illustrative" } } };
    }),
  };
}

async function createProperty(opts: {
  agencyId: string;
  slug: string;
  title: string;
  price: number;
  location: string;
  lat: number;
  lng: number;
  bedrooms: number;
  bathrooms: number;
  sqm: number;
  description: string;
  features: string[];
  plans: PlanSpec[];
  planStatus: "authored" | "generated";
  floorsCount: number;
  unitFloorIndex: number | null;
  facadeColor: string;
  facade: FacadeSpec;
  units?: { code: string; level: number; bedrooms: number; sqm: number; price: number; availability: string }[];
}) {
  await q("delete from properties where slug=$1", [opts.slug]);
  const p = await one<{ id: string }>(
    `insert into properties(agency_id, slug, status, title, price, currency, price_text, location, lat, lng, bedrooms, bathrooms, sqm,
       availability, description, features, published_at, source_adapter)
     values ($1,$2,'published',$3,$4,'EUR',$5,$6,$7,$8,$9,$10,$11,'Available',$12,$13, now(), 'seed') returning id`,
    [
      opts.agencyId, opts.slug, opts.title, opts.price,
      new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(opts.price),
      opts.location, opts.lat, opts.lng, opts.bedrooms, opts.bathrooms, opts.sqm, opts.description, JSON.stringify(opts.features),
    ],
  );
  const contextFloors = opts.floorsCount - opts.plans.length;
  const b = await one<{ id: string }>(
    "insert into buildings(property_id, name, floors_count, unit_floor_index, massing) values ($1,'Main building',$2,$3,$4) returning id",
    [p!.id, opts.floorsCount, opts.unitFloorIndex, JSON.stringify({ facadeColor: opts.facadeColor, facadeFromPhoto: false, roof: opts.facade.roof, facade: opts.facade, floorsCount: opts.floorsCount, contextFloors, provenance: "illustrative" })],
  );
  let y = 0;
  for (const [i, raw] of opts.plans.entries()) {
    const plan = withMaterials(raw);
    const img = await planPng(plan);
    const mediaId = await storeMedia(p!.id, img.png, "image/png", {
      kind: "floorplan",
      alt: `${i === 0 ? "Ground" : "First"} floor plan (demo)`,
      sort: 100 + i,
      classification: { class: "floorplan", roomType: null, amenity: null, confidence: 1, caption: "Demo floor plan", levelHint: null },
    });
    const media = await one("select s3_key from media_assets where id=$1", [mediaId]);
    plan.underlay = { mediaId: mediaId!, url: fileUrl(media.s3_key)!, widthPx: img.width, heightPx: img.height, originM: img.origin, metersPerPixel: 1 / 60 };
    const level = opts.unitFloorIndex ?? i;
    const f = await one<{ id: string }>(
      "insert into floors(building_id, level, name, elevation_m, plan_spec, plan_status, source_media_id) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [b!.id, level, opts.unitFloorIndex != null ? `Floor ${level} (unit)` : i === 0 ? "Ground floor" : "First floor", opts.unitFloorIndex != null ? level * 3.1 : y, JSON.stringify(plan), opts.planStatus, mediaId],
    );
    await q("update media_assets set floor_id=$2 where id=$1", [mediaId, f!.id]);
    await syncRooms(f!.id, plan);
    for (const u of opts.units ?? []) {
      if (u.level === level) await q("insert into units(floor_id, code, bedrooms, sqm, price, availability) values ($1,$2,$3,$4,$5,$6)", [f!.id, u.code, u.bedrooms, u.sqm, u.price, u.availability]);
    }
    y += plan.ceilingHeight + plan.slabThickness;
  }
  // build the 3D (GLB) and hotspots with the workers
  const job = await createJob(p!.id, "rebake", { seed: true }, initialSteps(["fetch", "ingest", "classify", "structure", "floorplan", "match", "materials", "panorama", "splat", "exterior"]));
  await pipelineQueue().add("rebake", { jobId: job!.id, propertyId: p!.id, mode: "rebake" }, { removeOnComplete: 100 });
  return p!.id;
}

async function main() {
  await migrate();
  await ensureBucket();
  if (process.argv.includes("--if-empty") && (await one("select 1 from agencies limit 1"))) {
    console.log("seed: data present, skipping (--if-empty)");
    await pool.end();
    process.exit(0);
  }
  await putObject("library/README.txt", "Drop CC0 GLB furniture here (see README: furniture library).", "text/plain");

  const agency = await one<{ id: string }>(
    `insert into agencies(slug, name, theme, whatsapp, booking_url, website) values ('future-homes','Future Homes',$1,$2,$3,$4)
     on conflict (slug) do update set theme=excluded.theme, name=excluded.name returning id`,
    [JSON.stringify(FH_THEME), process.env.SEED_AGENCY_WHATSAPP ?? "34600000000", process.env.SEED_AGENCY_BOOKING_URL ?? "https://futurehomesinternational.com/contact/", "https://futurehomesinternational.com"],
  );
  // Content rights for the agency's own site. Revoke in Admin → Sources if this does not apply.
  await q(
    `insert into scrape_sources(domain, adapter, rights_confirmed, confirmed_by, confirmed_at, rate_limit_ms, notes)
     values ('futurehomesinternational.com','futurehomes', $1, 'seed: project owner (Future Homes)', case when $1 then now() end, 3000,
             'Agency''s own listings. Confirm/revoke in Admin → Sources.')
     on conflict (domain) do nothing`,
    [process.env.SEED_CONFIRM_FUTUREHOMES !== "false"],
  );

  const villa = await createProperty({
    agencyId: agency!.id,
    slug: "villa-serena-demo",
    title: "Villa Serena (demo)",
    price: 2450000,
    location: "Marbella, Málaga, Spain (fictional demo)",
    lat: 36.5101,
    lng: -4.8825,
    bedrooms: 4,
    bathrooms: 3,
    sqm: 260,
    description:
      "Fictional demo property. A contemporary two-storey villa with an open-plan living and dining area, a kitchen opening to the terrace, a guest suite on the ground floor and three bedrooms upstairs.",
    features: ["Private pool", "Sea views", "Underfloor heating", "Air conditioning"],
    plans: demoVillaPlans(),
    planStatus: "authored",
    floorsCount: 2,
    unitFloorIndex: null,
    facadeColor: "#f4f1ea",
    // what the vision model returns for a modern Mediterranean villa photo (demo values)
    facade: {
      storeys: 2, roof: "flat", roofMaterial: "membrane", roofColor: "#d8d3ca", wallMaterial: "render", wallColor: "#f4f1ea",
      accentMaterial: "stone", accentColor: "#c9b79c", accentPlacement: "ground_floor", windowStyle: "large_glazing",
      windowFrameColor: "#2f3236", shutters: false, shutterColor: "#ffffff", balconies: "glass", roofTerrace: true,
      pergola: true, pool: true, garden: true, style: "modern mediterranean villa", confidence: 0.9,
    },
  });

  const [apt] = generateIllustrativePlans({ sqm: 92, bedrooms: 2, bathrooms: 2 });
  const apartment = await createProperty({
    agencyId: agency!.id,
    slug: "mar-azul-2b-demo",
    title: "Mar Azul Residences, Apartment 2B (demo)",
    price: 465000,
    location: "Estepona, Málaga, Spain (fictional demo)",
    lat: 36.4259,
    lng: -5.1462,
    bedrooms: 2,
    bathrooms: 2,
    sqm: 92,
    description: "Fictional demo: second-floor apartment in a six-storey residence. Layout is illustrative (generated from bedrooms/bathrooms/size).",
    features: ["Communal pool", "Gym", "Rooftop terrace"],
    plans: [apt],
    planStatus: "generated",
    floorsCount: 6,
    unitFloorIndex: 2,
    facadeColor: "#efe6d6",
    facade: {
      storeys: 6, roof: "flat", roofMaterial: "membrane", roofColor: "#cfcac0", wallMaterial: "render", wallColor: "#efe6d6",
      accentMaterial: "wood", accentColor: "#9a7451", accentPlacement: "entrance_wall", windowStyle: "floor_to_ceiling",
      windowFrameColor: "#3b3b3b", shutters: false, shutterColor: "#ffffff", balconies: "glass", roofTerrace: false,
      pergola: false, pool: true, garden: true, style: "contemporary residential", confidence: 0.9,
    },
    units: [{ code: "2B", level: 2, bedrooms: 2, sqm: 92, price: 465000, availability: "Available" }],
  });
  console.log(`seeded: villa=${villa} apartment=${apartment}`);
  console.log("demo viewer: /p/villa-serena-demo and /p/mar-azul-2b-demo");
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
