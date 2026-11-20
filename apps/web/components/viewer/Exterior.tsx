"use client";
import { useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { dist, roomAt, splitWall, type FacadeSpec, type Opening, type PlanSpec, type Vec2, type Wall } from "@pv/shared";
import { surfaceTexture } from "./textures";

/**
 * Exterior details driven by a FacadeSpec read from the listing's exterior photos:
 * facade material (+ accent cladding), window frames, shutters, balconies with railings,
 * pergola, roof shape/material and roof-terrace railing. All of it is ILLUSTRATIVE (a reading of
 * the photos, not a measurement) and the viewer's provenance badge says so.
 */
export const DEFAULT_FACADE: FacadeSpec = {
  storeys: 0,
  roof: "flat",
  roofMaterial: "membrane",
  roofColor: "#d9d4cb",
  wallMaterial: "render",
  wallColor: "#efe9df",
  accentMaterial: "none",
  accentColor: "#b9a48a",
  accentPlacement: "none",
  windowStyle: "punched",
  windowFrameColor: "#3a3a3a",
  shutters: false,
  shutterColor: "#ffffff",
  balconies: "none",
  roofTerrace: false,
  pergola: false,
  pool: false,
  garden: true,
  style: "contemporary",
  confidence: 0,
};

interface WallSide {
  wall: Wall;
  L: number;
  u: Vec2; // along the wall
  n: Vec2; // outward normal (plan)
}

/** Exterior walls with their outward normal (the side without a room). */
export function outerWalls(plan: PlanSpec): WallSide[] {
  const out: WallSide[] = [];
  for (const w of plan.walls) {
    const L = dist(w.a, w.b);
    if (L < 0.3) continue;
    const u: Vec2 = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L];
    const n0: Vec2 = [-u[1], u[0]];
    const mid: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
    const off = w.thickness / 2 + 0.35;
    const plus = roomAt(plan, [mid[0] + n0[0] * off, mid[1] + n0[1] * off]);
    const minus = roomAt(plan, [mid[0] - n0[0] * off, mid[1] - n0[1] * off]);
    if (plus && minus) continue; // interior wall
    if (!plus && !minus) continue; // free-standing
    out.push({ wall: w, L, u, n: plus ? [-n0[0], -n0[1]] : n0 });
  }
  return out;
}

/** quad on the plane of the wall's outer face; uv in metres (u along wall, v height) */
function quad(ws: WallSide, s0: number, s1: number, y0: number, y1: number, offset: number): THREE.BufferGeometry {
  const { wall, u, n } = ws;
  const o = wall.thickness / 2 + offset;
  const p = (s: number, y: number) => [wall.a[0] + u[0] * s + n[0] * o, y, wall.a[1] + u[1] * s + n[1] * o];
  const verts = [p(s0, y0), p(s1, y0), p(s1, y1), p(s0, y1)];
  // winding so the face points outward
  const cross = u[0] * n[1] - u[1] * n[0];
  // (p0,p1,p2) has normal (-u.z, 0, u.x); keep it if that already points outward
  const idx = cross > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts.flat(), 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute([s0, y0, s1, y0, s1, y1, s0, y1], 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

function boxAt(ws: WallSide, sMid: number, y: number, along: number, h: number, depth: number, out: number): THREE.BufferGeometry {
  const { wall, u, n } = ws;
  const g = new THREE.BoxGeometry(along, h, depth);
  g.rotateY(-Math.atan2(u[1], u[0]));
  const o = wall.thickness / 2 + out;
  g.translate(wall.a[0] + u[0] * sMid + n[0] * o, y, wall.a[1] + u[1] * sMid + n[1] * o);
  return g.toNonIndexed();
}

const merge = (gs: THREE.BufferGeometry[]) => (gs.length ? mergeGeometries(gs.map((g) => (g.index ? g.toNonIndexed() : g)), false) : null);

interface Built {
  facadeMain: THREE.BufferGeometry | null;
  facadeAccent: THREE.BufferGeometry | null;
  frames: THREE.BufferGeometry | null;
  shutters: THREE.BufferGeometry | null;
  balconySlabs: THREE.BufferGeometry | null;
  railsGlass: THREE.BufferGeometry | null;
  railsSolid: THREE.BufferGeometry | null;
  pergola: THREE.BufferGeometry | null;
}

function build(plan: PlanSpec, spec: FacadeSpec, level: number, isTop: boolean): Built {
  const H = plan.ceilingHeight;
  const S = plan.slabThickness;
  const sides = outerWalls(plan);
  const accentOn = spec.accentMaterial !== "none";
  const entranceWall = plan.openings.find((o) => o.type === "door" && sides.some((s) => s.wall.id === o.wallId))?.wallId;
  const isAccent = (ws: WallSide) =>
    accentOn &&
    ((spec.accentPlacement === "ground_floor" && level === 0) ||
      (spec.accentPlacement === "upper_floor" && level > 0) ||
      (spec.accentPlacement === "entrance_wall" && ws.wall.id === entranceWall));
  const main: THREE.BufferGeometry[] = [],
    accent: THREE.BufferGeometry[] = [],
    frames: THREE.BufferGeometry[] = [],
    shutters: THREE.BufferGeometry[] = [],
    slabs: THREE.BufferGeometry[] = [],
    glass: THREE.BufferGeometry[] = [],
    solid: THREE.BufferGeometry[] = [],
    pergola: THREE.BufferGeometry[] = [];
  const parapet = isTop && spec.roof === "flat" ? 0.5 + S : 0;

  for (const ws of sides) {
    const { wall, L } = ws;
    const t = wall.thickness;
    for (const p of splitWall(wall, plan.openings, H)) {
      if (p.kind !== "solid") continue;
      const e0 = p.s0 <= 1e-6 ? t / 2 : 0,
        e1 = p.s1 >= L - 1e-6 ? t / 2 : 0;
      const y0 = p.z0 <= 1e-6 ? -S : p.z0;
      // the storey above covers this floor's slab edge (avoids coplanar z-fighting); the top floor adds the parapet
      const y1 = p.z1 >= H - 1e-6 ? (isTop ? H + S + parapet : H) : p.z1;
      (isAccent(ws) ? accent : main).push(quad(ws, p.s0 - e0, p.s1 + e1, y0, y1, 0.004));
    }
    const ops = plan.openings.filter((o) => o.wallId === wall.id && o.type !== "opening");
    for (const o of ops) {
      const c = o.t * L,
        w = Math.min(o.width, L);
      const s0 = c - w / 2,
        s1 = c + w / 2;
      const sill = o.type === "window" ? o.sill : 0;
      const head = Math.min(o.head, H);
      const f = 0.06;
      // frame: jambs, head, sill (+ centre mullion for sliding doors / wide glazing)
      frames.push(boxAt(ws, s0 + f / 2, (sill + head) / 2, f, head - sill, f, f / 2));
      frames.push(boxAt(ws, s1 - f / 2, (sill + head) / 2, f, head - sill, f, f / 2));
      frames.push(boxAt(ws, c, head - f / 2, w, f, f, f / 2));
      frames.push(boxAt(ws, c, sill + f / 2, w, f, o.type === "window" ? 0.12 : f, o.type === "window" ? 0.06 : f / 2));
      if (o.type === "sliding" || w > 2.2) frames.push(boxAt(ws, c, (sill + head) / 2, f, head - sill, f, f / 2));
      if (spec.shutters && o.type === "window" && w <= 1.8) {
        const sw = w / 2;
        if (s0 - sw > 0.05) shutters.push(boxAt(ws, s0 - sw / 2 - 0.02, (sill + head) / 2, sw, head - sill, 0.035, 0.03));
        if (s1 + sw < L - 0.05) shutters.push(boxAt(ws, s1 + sw / 2 + 0.02, (sill + head) / 2, sw, head - sill, 0.035, 0.03));
      }
      // balconies on upper floors in front of doors / full-height glazing
      const fullHeight = o.type === "sliding" || o.type === "door" || (o.type === "window" && o.sill < 0.5 && w >= 1.6);
      if (spec.balconies !== "none" && level > 0 && fullHeight) {
        const bw = Math.min(L, w + 1.2),
          depth = 1.4;
        slabs.push(boxAt(ws, c, -0.09, bw, 0.18, depth, depth / 2));
        const railH = 1.05;
        const rails = spec.balconies === "glass" ? glass : solid;
        const thick = spec.balconies === "masonry" ? 0.15 : spec.balconies === "glass" ? 0.02 : 0.04;
        rails.push(boxAt(ws, c, railH / 2, bw, railH, thick, depth - thick / 2));
        for (const side of [-1, 1]) {
          const g = new THREE.BoxGeometry(thick, railH, depth);
          g.rotateY(-Math.atan2(ws.u[1], ws.u[0]));
          const sx = c + (side * bw) / 2,
            o2 = t / 2 + depth / 2;
          g.translate(wall.a[0] + ws.u[0] * sx + ws.n[0] * o2, railH / 2, wall.a[1] + ws.u[1] * sx + ws.n[1] * o2);
          rails.push(g.toNonIndexed());
        }
        if (spec.balconies === "glass") solid.push(boxAt(ws, c, railH + 0.02, bw, 0.04, 0.05, depth - 0.03)); // handrail
      }
      // pergola over the main ground-floor sliding door
      if (spec.pergola && level === 0 && o.type === "sliding" && pergola.length === 0) {
        const pw = w + 1.6,
          depth = 3.2,
          ph = 2.75;
        for (const side of [-1, 1]) pergola.push(boxAt(ws, c + (side * pw) / 2, ph / 2, 0.12, ph, 0.12, depth));
        pergola.push(boxAt(ws, c, ph, pw + 0.2, 0.16, 0.12, depth));
        for (let k = 0; k <= 12; k++) pergola.push(boxAt(ws, c - pw / 2 + (k * pw) / 12, ph + 0.12, 0.05, 0.08, depth + 0.1, depth / 2));
      }
    }
    // roof terrace railing on top of the parapet line
    if (isTop && spec.roof === "flat" && spec.roofTerrace) {
      glass.push(boxAt(ws, L / 2, H + S + 0.5 + 0.45, L + t, 0.9, 0.02, 0));
    }
  }
  return {
    facadeMain: merge(main),
    facadeAccent: merge(accent),
    frames: merge(frames),
    shutters: merge(shutters),
    balconySlabs: merge(slabs),
    railsGlass: merge(glass),
    railsSolid: merge(solid),
    pergola: merge(pergola),
  };
}

/** Pitched roofs (gable / hip / shed / mansard) over the top floor's outline. */
function pitchedRoof(plan: PlanSpec, spec: FacadeSpec): { roof: THREE.BufferGeometry; gables: THREE.BufferGeometry | null } | null {
  if (spec.roof === "flat") return null;
  const xs = plan.walls.flatMap((w) => [w.a[0], w.b[0]]),
    zs = plan.walls.flatMap((w) => [w.a[1], w.b[1]]);
  const t = Math.max(...plan.walls.map((w) => w.thickness), 0.2);
  const ov = 0.4 + t / 2;
  let x0 = Math.min(...xs) - ov,
    x1 = Math.max(...xs) + ov,
    z0 = Math.min(...zs) - ov,
    z1 = Math.max(...zs) + ov;
  const base = plan.ceilingHeight + plan.slabThickness;
  const alongX = x1 - x0 >= z1 - z0;
  // work in a local frame: a = along ridge, b = across
  const A0 = alongX ? x0 : z0,
    A1 = alongX ? x1 : z1,
    B0 = alongX ? z0 : x0,
    B1 = alongX ? z1 : x1;
  const span = B1 - B0;
  const pitch = ((spec.roof === "mansard" ? 50 : spec.roof === "shed" ? 12 : 30) * Math.PI) / 180;
  const P = (a: number, b: number, y: number) => (alongX ? [a, y, b] : [b, y, a]);
  const tris: number[][] = [];
  const gableTris: number[][] = [];
  const bm = (B0 + B1) / 2;
  if (spec.roof === "shed") {
    const h = span * Math.tan(pitch);
    tris.push(P(A0, B0, base + h), P(A1, B0, base + h), P(A1, B1, base), P(A0, B0, base + h), P(A1, B1, base), P(A0, B1, base));
    gableTris.push(P(A0, B0, base), P(A0, B0, base + h), P(A0, B1, base), P(A1, B0, base), P(A1, B1, base), P(A1, B0, base + h));
  } else {
    const h = (span / 2) * Math.tan(pitch);
    const inset = spec.roof === "gable" ? 0 : Math.min(span / 2, (A1 - A0) / 2 - 0.01);
    const r0 = A0 + inset,
      r1 = A1 - inset;
    // two long slopes
    tris.push(P(A0, B0, base), P(r1, bm, base + h), P(A1, B0, base), P(A0, B0, base), P(r0, bm, base + h), P(r1, bm, base + h));
    tris.push(P(A1, B1, base), P(r0, bm, base + h), P(A0, B1, base), P(A1, B1, base), P(r1, bm, base + h), P(r0, bm, base + h));
    if (spec.roof === "gable") {
      gableTris.push(P(A0, B0, base), P(A0, B1, base), P(A0, bm, base + h), P(A1, B0, base), P(A1, bm, base + h), P(A1, B1, base));
    } else {
      tris.push(P(A0, B1, base), P(r0, bm, base + h), P(A0, B0, base));
      tris.push(P(A1, B0, base), P(r1, bm, base + h), P(A1, B1, base));
    }
  }
  const mk = (pts: number[][], uvScale: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts.flat(), 3));
    const uv: number[] = [];
    for (const p of pts) uv.push(alongX ? p[0] : p[2], (Math.abs((alongX ? p[2] : p[0]) - bm) + p[1]) * uvScale);
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    return g;
  };
  void x0, void x1, void z0, void z1;
  return { roof: mk(tris, 1), gables: gableTris.length ? mk(gableTris, 1) : null };
}

export function ExteriorDetails({ plan, spec, level, isTop, showRoof }: { plan: PlanSpec; spec: FacadeSpec; level: number; isTop: boolean; showRoof: boolean }) {
  const b = useMemo(() => build(plan, spec, level, isTop), [plan, spec, level, isTop]);
  const roof = useMemo(() => (isTop ? pitchedRoof(plan, spec) : null), [plan, spec, isTop]);
  const wallTex = useMemo(() => surfaceTexture(spec.wallMaterial, spec.wallColor), [spec.wallMaterial, spec.wallColor]);
  const accentTex = useMemo(() => surfaceTexture(spec.accentMaterial, spec.accentColor), [spec.accentMaterial, spec.accentColor]);
  const roofTex = useMemo(() => surfaceTexture(spec.roofMaterial, spec.roofColor), [spec.roofMaterial, spec.roofColor]);
  const wallRough = spec.wallMaterial === "glass" ? 0.1 : spec.wallMaterial === "render" ? 0.92 : 0.85;
  return (
    <group name="exterior-details">
      {b.facadeMain && (
        <mesh geometry={b.facadeMain} receiveShadow castShadow>
          <meshStandardMaterial map={wallTex} roughness={wallRough} metalness={spec.wallMaterial === "glass" ? 0.5 : 0} />
        </mesh>
      )}
      {b.facadeAccent && (
        <mesh geometry={b.facadeAccent} receiveShadow castShadow>
          <meshStandardMaterial map={accentTex} roughness={0.85} />
        </mesh>
      )}
      {b.frames && (
        <mesh geometry={b.frames} castShadow>
          <meshStandardMaterial color={spec.windowFrameColor} roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      {b.shutters && (
        <mesh geometry={b.shutters} castShadow>
          <meshStandardMaterial color={spec.shutterColor} roughness={0.7} />
        </mesh>
      )}
      {b.balconySlabs && (
        <mesh geometry={b.balconySlabs} castShadow receiveShadow>
          <meshStandardMaterial color={spec.wallColor} roughness={0.9} />
        </mesh>
      )}
      {b.railsSolid && (
        <mesh geometry={b.railsSolid} castShadow>
          <meshStandardMaterial
            color={spec.balconies === "masonry" ? spec.wallColor : spec.windowFrameColor}
            roughness={0.6}
            metalness={spec.balconies === "masonry" ? 0 : 0.4}
          />
        </mesh>
      )}
      {b.railsGlass && (
        <mesh geometry={b.railsGlass} renderOrder={2}>
          <meshStandardMaterial color="#9fb8c4" transparent opacity={0.32} roughness={0.05} metalness={0.2} depthWrite={false} />
        </mesh>
      )}
      {b.pergola && (
        <mesh geometry={b.pergola} castShadow receiveShadow>
          <meshStandardMaterial color={spec.accentMaterial === "wood" ? spec.accentColor : spec.windowFrameColor} roughness={0.7} />
        </mesh>
      )}
      {showRoof && roof && (
        <>
          <mesh geometry={roof.roof} castShadow receiveShadow>
            <meshStandardMaterial map={roofTex} roughness={0.8} side={THREE.DoubleSide} />
          </mesh>
          {roof.gables && (
            <mesh geometry={roof.gables} castShadow>
              <meshStandardMaterial map={wallTex} roughness={0.9} side={THREE.DoubleSide} />
            </mesh>
          )}
        </>
      )}
    </group>
  );
}

export type { Opening };
