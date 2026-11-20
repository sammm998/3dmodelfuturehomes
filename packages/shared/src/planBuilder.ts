import { polygonArea } from "./geometry";
import type { Opening, PlanRoom, PlanSpec, Provenance, RoomType, Vec2, Wall } from "./schemas";

/** Axis-aligned room rectangle in metres: [x0, y0, x1, y1]. */
export interface RectRoom {
  id: string;
  name: string;
  type: RoomType;
  rect: [number, number, number, number];
}

export interface RectPlanInput {
  rooms: RectRoom[];
  /** pairs of room ids to connect with a door; ["hall","OUTSIDE"] = entrance */
  doors: [string, string, ("door" | "opening" | "sliding")?][];
  ceilingHeight?: number;
  exteriorThickness?: number;
  interiorThickness?: number;
  provenance: Provenance;
  confidence?: number;
  notes?: string[];
  windowsFor?: (room: RectRoom) => boolean;
}

const EPS = 1e-6;
const key = (a: string | null, b: string | null) => `${a ?? "OUTSIDE"}|${b ?? "OUTSIDE"}`;

/**
 * Build a PlanSpec from tiled rectangles: shared edges become interior walls,
 * boundary edges exterior walls. Used by the illustrative generator and the seed data.
 */
export function buildRectPlan(input: RectPlanInput): PlanSpec {
  const extT = input.exteriorThickness ?? 0.3;
  const intT = input.interiorThickness ?? 0.12;
  const ceiling = input.ceilingHeight ?? 2.7;
  const walls: (Wall & { rooms: [string | null, string | null] })[] = [];

  for (const orient of ["h", "v"] as const) {
    // lines: coordinate -> list of [start,end,roomId,side]
    const lines = new Map<number, { s: number; e: number; room: string; side: -1 | 1 }[]>();
    const push = (c: number, s: number, e: number, room: string, side: -1 | 1) => {
      const k = Math.round(c * 1000) / 1000;
      if (!lines.has(k)) lines.set(k, []);
      lines.get(k)!.push({ s, e, room, side });
    };
    for (const r of input.rooms) {
      const [x0, y0, x1, y1] = r.rect;
      if (orient === "h") {
        push(y0, x0, x1, r.id, 1); // room lies on +y side of line y0
        push(y1, x0, x1, r.id, -1);
      } else {
        push(x0, y0, y1, r.id, 1);
        push(x1, y0, y1, r.id, -1);
      }
    }
    for (const [c, items] of lines) {
      const bps = [...new Set(items.flatMap((i) => [i.s, i.e]))].sort((a, b) => a - b);
      let cur: { s: number; e: number; pos: string | null; neg: string | null } | null = null;
      const flush = () => {
        if (!cur || (cur.pos === null && cur.neg === null)) return;
        const a: Vec2 = orient === "h" ? [cur.s, c] : [c, cur.s];
        const b: Vec2 = orient === "h" ? [cur.e, c] : [c, cur.e];
        const exterior = cur.pos === null || cur.neg === null;
        walls.push({
          id: `w${walls.length + 1}`,
          a,
          b,
          thickness: exterior ? extT : intT,
          exterior,
          rooms: [cur.pos, cur.neg],
        });
      };
      for (let i = 0; i < bps.length - 1; i++) {
        const s = bps[i],
          e = bps[i + 1];
        if (e - s < EPS) continue;
        const m = (s + e) / 2;
        const pos = items.find((it) => it.side === 1 && it.s <= m && it.e >= m)?.room ?? null;
        const neg = items.find((it) => it.side === -1 && it.s <= m && it.e >= m)?.room ?? null;
        if (pos === null && neg === null) {
          flush();
          cur = null;
          continue;
        }
        if (cur && cur.pos === pos && cur.neg === neg && Math.abs(cur.e - s) < EPS) cur.e = e;
        else {
          flush();
          cur = { s, e, pos, neg };
        }
      }
      flush();
    }
  }

  const openings: Opening[] = [];
  const wallLen = (w: Wall) => Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  for (const [r1, r2, type] of input.doors) {
    const k1 = r1 === "OUTSIDE" ? null : r1;
    const k2 = r2 === "OUTSIDE" ? null : r2;
    const cands = walls
      .filter((w) => key(w.rooms[0], w.rooms[1]) === key(k1, k2) || key(w.rooms[0], w.rooms[1]) === key(k2, k1))
      .sort((a, b) => wallLen(b) - wallLen(a));
    const w = cands[0];
    if (!w) continue;
    const L = wallLen(w);
    const kind = type ?? "door";
    const width = Math.min(kind === "opening" ? Math.min(2.4, L * 0.6) : kind === "sliding" ? 2.4 : 0.9, L - 0.2);
    if (width < 0.6) continue;
    openings.push({ id: `o${openings.length + 1}`, wallId: w.id, type: kind, t: 0.5, width, sill: 0, head: 2.1 });
  }

  // windows on exterior walls
  const roomById = new Map(input.rooms.map((r) => [r.id, r]));
  const wantsWindow =
    input.windowsFor ?? ((r: RectRoom) => !["hall", "storage", "stairs", "laundry", "garage"].includes(r.type));
  for (const w of walls) {
    if (!w.exterior) continue;
    const rid = w.rooms[0] ?? w.rooms[1];
    const room = rid ? roomById.get(rid) : undefined;
    if (!room || !wantsWindow(room)) continue;
    const L = wallLen(w);
    if (L < 1.4) continue;
    const used = openings.filter((o) => o.wallId === w.id);
    const n = Math.max(1, Math.floor(L / 3.2));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      if (used.some((o) => Math.abs(o.t - t) * L < (o.width + 1.4) / 2)) continue;
      const big = ["living", "dining", "kitchen"].includes(room.type);
      const tall = big && L > 3;
      openings.push({
        id: `o${openings.length + 1}`,
        wallId: w.id,
        type: "window",
        t,
        width: Math.min(big ? 2.0 : 1.2, L / n - 0.4),
        sill: tall ? 0.1 : room.type === "bathroom" || room.type === "wc" ? 1.4 : 0.9,
        head: 2.2,
      });
    }
  }

  const rooms: PlanRoom[] = input.rooms.map((r) => {
    const [x0, y0, x1, y1] = r.rect;
    const polygon: Vec2[] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
    return { id: r.id, name: r.name, type: r.type, polygon, areaM2: Math.round(polygonArea(polygon) * 10) / 10 };
  });

  return {
    version: 1,
    ceilingHeight: ceiling,
    slabThickness: 0.25,
    walls: walls.map(({ rooms: _r, ...w }) => w),
    openings,
    rooms,
    stairs: [],
    scale: { metersPerPixel: null, source: "authored" },
    underlay: null,
    confidence: input.confidence ?? 1,
    provenance: input.provenance,
    notes: input.notes ?? [],
  };
}

/** Centre a plan on the origin (keeps geometry, shifts coordinates). */
export function centerPlan(plan: PlanSpec): PlanSpec {
  const xs = plan.walls.flatMap((w) => [w.a[0], w.b[0]]);
  const ys = plan.walls.flatMap((w) => [w.a[1], w.b[1]]);
  if (!xs.length) return plan;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const sh = (p: Vec2): Vec2 => [p[0] - cx, p[1] - cy];
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, a: sh(w.a), b: sh(w.b) })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(sh) })),
    stairs: plan.stairs.map((s) => ({ polygon: s.polygon.map(sh) })),
    underlay: plan.underlay ? { ...plan.underlay, originM: sh(plan.underlay.originM) } : null,
  };
}

/** Shift a plan by an offset (used to align stacked floors). */
export function translatePlan(plan: PlanSpec, dx: number, dy: number): PlanSpec {
  const sh = (p: Vec2): Vec2 => [p[0] + dx, p[1] + dy];
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, a: sh(w.a), b: sh(w.b) })),
    rooms: plan.rooms.map((r) => ({ ...r, polygon: r.polygon.map(sh) })),
    stairs: plan.stairs.map((s) => ({ polygon: s.polygon.map(sh) })),
    underlay: plan.underlay ? { ...plan.underlay, originM: sh(plan.underlay.originM) } : null,
  };
}
