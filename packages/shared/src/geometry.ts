import type { Opening, PlanSpec, Vec2, Wall } from "./schemas.js";

export const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const mul = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const len = (a: Vec2) => Math.hypot(a[0], a[1]);
export const dist = (a: Vec2, b: Vec2) => len(sub(a, b));
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export function polygonArea(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(poly: Vec2[]): Vec2 {
  let a = 0,
    cx = 0,
    cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    a += f;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = poly.length;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(points: Vec2[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function planBounds(plan: PlanSpec) {
  const pts: Vec2[] = [];
  for (const w of plan.walls) pts.push(w.a, w.b);
  for (const r of plan.rooms) pts.push(...r.polygon);
  if (!pts.length) return { minX: -5, minY: -5, maxX: 5, maxY: 5, w: 10, h: 10 };
  return bounds(pts);
}

/** A solid piece of wall, in wall-local coordinates: [s0,s1] along the wall, [z0,z1] in height. */
export interface WallPiece {
  wallId: string;
  s0: number;
  s1: number;
  z0: number;
  z1: number;
  /** "glass" pieces are window panes, rendered transparent and not collidable */
  kind: "solid" | "glass";
}

/**
 * Split a wall into solid boxes around its openings.
 * The same algorithm is used in the Python bake worker (geometry/extrude.py).
 */
export function splitWall(wall: Wall, openings: Opening[], height: number): WallPiece[] {
  const L = dist(wall.a, wall.b);
  const ops = openings
    .filter((o) => o.wallId === wall.id)
    .map((o) => {
      const half = Math.min(o.width, L) / 2;
      const c = o.t * L;
      return { s0: Math.max(0, c - half), s1: Math.min(L, c + half), o };
    })
    .sort((a, b) => a.s0 - b.s0);
  const pieces: WallPiece[] = [];
  let cursor = 0;
  for (const { s0, s1, o } of ops) {
    if (s0 > cursor + 1e-3) pieces.push({ wallId: wall.id, s0: cursor, s1: s0, z0: 0, z1: height, kind: "solid" });
    const head = Math.min(o.head, height);
    if (head < height - 1e-3) pieces.push({ wallId: wall.id, s0, s1, z0: head, z1: height, kind: "solid" });
    if (o.sill > 1e-3) pieces.push({ wallId: wall.id, s0, s1, z0: 0, z1: o.sill, kind: "solid" });
    if (o.type === "window") pieces.push({ wallId: wall.id, s0, s1, z0: o.sill, z1: head, kind: "glass" });
    cursor = Math.max(cursor, s1);
  }
  if (cursor < L - 1e-3) pieces.push({ wallId: wall.id, s0: cursor, s1: L, z0: 0, z1: height, kind: "solid" });
  return pieces;
}

/** 2D collision segments: solid wall parts that reach below head height (i.e. block walking). */
export function collisionSegments(plan: PlanSpec): { a: Vec2; b: Vec2; r: number }[] {
  const segs: { a: Vec2; b: Vec2; r: number }[] = [];
  for (const w of plan.walls) {
    const L = dist(w.a, w.b);
    if (L < 1e-6) continue;
    const dir = mul(sub(w.b, w.a), 1 / L);
    for (const p of splitWall(w, plan.openings, plan.ceilingHeight)) {
      // windows (glass + sill) block; door lintels above 1.8m don't
      if (p.z0 > 1.8) continue;
      segs.push({ a: add(w.a, mul(dir, p.s0)), b: add(w.a, mul(dir, p.s1)), r: w.thickness / 2 });
    }
  }
  return segs;
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  if (l2 < 1e-12) return a;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
  return [a[0] + ab[0] * t, a[1] + ab[1] * t];
}

/**
 * Move a circle (player) from p by delta, sliding along walls.
 * Iterative push-out; robust for the small steps of a walk controller.
 */
export function moveWithCollisions(
  p: Vec2,
  delta: Vec2,
  segs: { a: Vec2; b: Vec2; r: number }[],
  radius = 0.25,
): Vec2 {
  const steps = Math.max(1, Math.ceil(len(delta) / 0.1));
  let pos: Vec2 = [...p] as Vec2;
  const d = mul(delta, 1 / steps);
  for (let s = 0; s < steps; s++) {
    pos = add(pos, d);
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const seg of segs) {
        const c = closestPointOnSegment(pos, seg.a, seg.b);
        const v = sub(pos, c);
        const dd = len(v);
        const minD = radius + seg.r;
        if (dd < minD) {
          const n: Vec2 = dd > 1e-6 ? mul(v, 1 / dd) : [0, 1];
          pos = add(c, mul(n, minD + 1e-4));
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  return pos;
}

export function roomAt(plan: PlanSpec, p: Vec2) {
  return plan.rooms.find((r) => pointInPolygon(p, r.polygon)) ?? null;
}

/** Rooms connected by a door/opening: used for 360° navigation links. */
export function roomAdjacency(plan: PlanSpec): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const r of plan.rooms) adj.set(r.id, new Set());
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  for (const o of plan.openings) {
    if (o.type === "window") continue;
    const w = wallById.get(o.wallId);
    if (!w) continue;
    const c = lerp(w.a, w.b, o.t);
    const L = dist(w.a, w.b) || 1;
    const n: Vec2 = [-(w.b[1] - w.a[1]) / L, (w.b[0] - w.a[0]) / L];
    const off = w.thickness / 2 + 0.15;
    const r1 = roomAt(plan, add(c, mul(n, off)));
    const r2 = roomAt(plan, add(c, mul(n, -off)));
    if (r1 && r2 && r1.id !== r2.id) {
      adj.get(r1.id)!.add(r2.id);
      adj.get(r2.id)!.add(r1.id);
    }
  }
  return adj;
}

/** Outer footprint as the bounding polygon of exterior walls (falls back to plan bounds rectangle). */
export function footprint(plan: PlanSpec): Vec2[] {
  const b = planBounds(plan);
  return [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
  ];
}
