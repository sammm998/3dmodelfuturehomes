import { bounds, dist, lerp } from "./geometry.js";
import type { PlanRoom, PlanSpec, Vec2 } from "./schemas.js";

export type FurnitureKind =
  | "bed"
  | "nightstand"
  | "wardrobe"
  | "sofa"
  | "coffee_table"
  | "tv_unit"
  | "rug"
  | "dining_table"
  | "chair"
  | "counter"
  | "island"
  | "fridge"
  | "toilet"
  | "sink"
  | "shower"
  | "bathtub"
  | "desk"
  | "plant"
  | "lounger";

export interface FurnitureItem {
  kind: FurnitureKind;
  roomId: string;
  /** centre position in plan metres */
  x: number;
  y: number;
  /** rotation around vertical axis, radians (0 = facing +y) */
  rot: number;
  w: number;
  d: number;
  h: number;
  /** optional GLB from the library manifest; otherwise rendered procedurally */
  glb?: string;
}

/**
 * Rule-based furniture placement for (roughly rectangular) rooms.
 * Items are ILLUSTRATIVE. Placement avoids door swing zones.
 */
export function layoutFurniture(plan: PlanSpec): FurnitureItem[] {
  const items: FurnitureItem[] = [];
  const doorPts: Vec2[] = [];
  const wallById = new Map(plan.walls.map((w) => [w.id, w]));
  for (const o of plan.openings) {
    if (o.type === "window") continue;
    const w = wallById.get(o.wallId);
    if (w) doorPts.push(lerp(w.a, w.b, o.t));
  }
  for (const room of plan.rooms) items.push(...furnishRoom(room, doorPts));
  return items;
}

function furnishRoom(room: PlanRoom, doors: Vec2[]): FurnitureItem[] {
  const b = bounds(room.polygon);
  const inset = 0.12;
  const x0 = b.minX + inset,
    x1 = b.maxX - inset,
    y0 = b.minY + inset,
    y1 = b.maxY - inset;
  const W = x1 - x0,
    D = y1 - y0;
  if (W < 1 || D < 1) return [];
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const nearDoor = (p: Vec2, r = 1.0) => doors.some((d) => dist(d, p) < r);
  // candidate "back walls": choose the side with the fewest doors close to it
  const sides = [
    { name: "minY", p: [cx, y0] as Vec2, rot: 0, len: W },
    { name: "maxY", p: [cx, y1] as Vec2, rot: Math.PI, len: W },
    { name: "minX", p: [x0, cy] as Vec2, rot: Math.PI / 2, len: D },
    { name: "maxX", p: [x1, cy] as Vec2, rot: -Math.PI / 2, len: D },
  ];
  const doorScore = (s: (typeof sides)[number]) => doors.filter((d) => dist(d, s.p) < s.len / 2 + 0.6).length;
  const back = [...sides].sort((a, b) => doorScore(a) - doorScore(b) || b.len - a.len)[0];
  const inward: Vec2 = [Math.sin(back.rot), Math.cos(back.rot)];
  const along: Vec2 = [Math.cos(back.rot), -Math.sin(back.rot)];
  const at = (offAlong: number, offIn: number): Vec2 => [
    back.p[0] + along[0] * offAlong + inward[0] * offIn,
    back.p[1] + along[1] * offAlong + inward[1] * offIn,
  ];
  const depthIn = back.name === "minY" || back.name === "maxY" ? D : W;
  const id = room.id;
  const mk = (kind: FurnitureKind, p: Vec2, rot: number, w: number, d: number, h: number): FurnitureItem => ({
    kind,
    roomId: id,
    x: p[0],
    y: p[1],
    rot,
    w,
    d,
    h,
  });
  const out: FurnitureItem[] = [];

  switch (room.type) {
    case "bedroom": {
      const bw = back.len > 3.2 ? 1.8 : back.len > 2.6 ? 1.6 : 0.9;
      out.push(mk("bed", at(0, 1.05), back.rot, bw, 2.05, 0.5));
      if (back.len > bw + 1.2) {
        out.push(mk("nightstand", at(-(bw / 2 + 0.3), 0.25), back.rot, 0.45, 0.4, 0.5));
        out.push(mk("nightstand", at(bw / 2 + 0.3, 0.25), back.rot, 0.45, 0.4, 0.5));
      }
      if (depthIn > 3.4) out.push(mk("wardrobe", at(0, depthIn - 0.3), back.rot + Math.PI, Math.min(2.2, back.len - 0.6), 0.6, 2.2));
      out.push(mk("rug", at(0, 1.4), back.rot, Math.min(back.len - 0.4, bw + 1), 2.2, 0.01));
      break;
    }
    case "living":
    case "dining": {
      const sw = Math.min(2.6, back.len - 0.8);
      if (sw > 1.4) {
        out.push(mk("sofa", at(0, 0.5), back.rot, sw, 0.95, 0.8));
        out.push(mk("coffee_table", at(0, 1.6), back.rot, Math.min(1.2, sw * 0.5), 0.6, 0.4));
        out.push(mk("rug", at(0, 1.5), back.rot, Math.min(3, sw + 0.6), 2.2, 0.01));
        if (depthIn > 3.6) out.push(mk("tv_unit", at(0, Math.min(depthIn - 0.25, 3.3)), back.rot + Math.PI, 1.8, 0.4, 0.5));
      }
      if (room.areaM2 > 24 && depthIn > 4.8) {
        const dt = at(0, depthIn - 1.3);
        out.push(mk("dining_table", dt, back.rot, 1.8, 0.95, 0.75));
        for (const s of [-0.5, 0.5])
          for (const side of [-1, 1]) {
            const p: Vec2 = [dt[0] + along[0] * s + inward[0] * side * 0.7, dt[1] + along[1] * s + inward[1] * side * 0.7];
            out.push(mk("chair", p, back.rot + (side > 0 ? Math.PI : 0), 0.45, 0.45, 0.85));
          }
      }
      out.push(mk("plant", at(back.len / 2 - 0.35, 0.35), 0, 0.4, 0.4, 1.3));
      break;
    }
    case "kitchen": {
      const cl = back.len - 0.2;
      out.push(mk("counter", at(0, 0.32), back.rot, cl, 0.64, 0.9));
      out.push(mk("fridge", at(cl / 2 - 0.35, 0.35), back.rot, 0.7, 0.7, 2.0));
      if (depthIn > 3.6 && back.len > 3) out.push(mk("island", at(0, 2.0), back.rot, Math.min(2.2, cl - 1.2), 0.95, 0.92));
      break;
    }
    case "bathroom": {
      if (back.len >= 2.4 && depthIn >= 1.8) out.push(mk("bathtub", at(0, 0.38), back.rot, 1.7, 0.75, 0.55));
      else out.push(mk("shower", at(-(back.len / 2 - 0.5), 0.5), back.rot, 0.9, 0.9, 0.05));
      out.push(mk("sink", at(back.len / 2 - 0.4, depthIn - 0.25), back.rot + Math.PI, 0.7, 0.45, 0.85));
      out.push(mk("toilet", at(-(back.len / 2 - 0.35), depthIn - 0.35), back.rot + Math.PI, 0.4, 0.65, 0.4));
      break;
    }
    case "wc": {
      out.push(mk("toilet", at(0, 0.35), back.rot, 0.4, 0.65, 0.4));
      out.push(mk("sink", at(0, Math.max(0.9, depthIn - 0.25)), back.rot + Math.PI, 0.5, 0.35, 0.85));
      break;
    }
    case "office": {
      out.push(mk("desk", at(0, 0.4), back.rot, Math.min(1.6, back.len - 0.4), 0.75, 0.75));
      out.push(mk("chair", at(0, 1.05), back.rot + Math.PI, 0.5, 0.5, 0.9));
      break;
    }
    case "terrace":
    case "balcony": {
      if (back.len > 2.2) {
        out.push(mk("lounger", at(-0.6, 1.1), back.rot, 0.7, 1.9, 0.35));
        out.push(mk("lounger", at(0.6, 1.1), back.rot, 0.7, 1.9, 0.35));
      }
      out.push(mk("plant", at(back.len / 2 - 0.35, 0.35), 0, 0.5, 0.5, 1.1));
      break;
    }
  }
  return out.filter((it) => !nearDoor([it.x, it.y], 0.75) || it.kind === "rug");
}
