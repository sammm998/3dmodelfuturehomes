import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { dist, roomAt, splitWall, type PlanSpec, type Vec2 } from "@pv/shared";

export interface FloorGeometry {
  walls: THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry | null;
  parapet: THREE.BufferGeometry | null;
  rooms: { id: string; type: string; geometry: THREE.BufferGeometry; ceiling: THREE.BufferGeometry; color: string; kind: string; textureKey?: string }[];
  roof: THREE.BufferGeometry | null;
  height: number;
}

const DEFAULT_WALL = "#f2efe9";

function shapeFrom(poly: Vec2[]) {
  const s = new THREE.Shape();
  poly.forEach(([x, y], i) => (i ? s.lineTo(x, -y) : s.moveTo(x, -y)));
  s.closePath();
  return s;
}

/** Flat shape in the XZ plane at height y (plan y → world z). UVs are in metres. */
function flat(poly: Vec2[], y: number) {
  const g = new THREE.ShapeGeometry(shapeFrom(poly));
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  return g;
}

function slab(poly: Vec2[], y0: number, h: number) {
  const g = new THREE.ExtrudeGeometry(shapeFrom(poly), { depth: h, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/**
 * Walls as merged boxes with per-face vertex colours: each vertical face is coloured by the room
 * it faces (room wall paint), or the facade colour when it faces outside.
 */
export function buildFloorGeometry(plan: PlanSpec, opts: { facadeColor: string; isTop: boolean }): FloorGeometry {
  const H = plan.ceilingHeight;
  const S = plan.slabThickness;
  const solids: THREE.BufferGeometry[] = [];
  const glass: THREE.BufferGeometry[] = [];
  const parapets: THREE.BufferGeometry[] = [];
  const facade = new THREE.Color(opts.facadeColor);
  const roomColor = new Map(plan.rooms.map((r) => [r.id, new THREE.Color(r.materials?.walls?.color ?? DEFAULT_WALL)]));
  const top = new THREE.Color("#e9e4dc");
  const tmp = new THREE.Vector3();
  const n = new THREE.Vector3();

  for (const w of plan.walls) {
    const L = dist(w.a, w.b);
    if (L < 1e-3) continue;
    const ux = (w.b[0] - w.a[0]) / L,
      uy = (w.b[1] - w.a[1]) / L;
    const angle = -Math.atan2(uy, ux);
    for (const p of splitWall(w, plan.openings, H)) {
      const solid = p.kind === "solid";
      const ext0 = solid && p.s0 <= 1e-6 ? w.thickness / 2 : 0;
      const ext1 = solid && p.s1 >= L - 1e-6 ? w.thickness / 2 : 0;
      const len = p.s1 - p.s0 + ext0 + ext1;
      const z0 = solid && p.z0 <= 1e-6 ? -S : p.z0; // extend to the slab underside so the facade is closed
      const h = p.z1 - z0;
      const thick = solid ? w.thickness : 0.03;
      const g = new THREE.BoxGeometry(len, h, thick);
      const mid = (p.s0 - ext0 + p.s1 + ext1) / 2;
      g.rotateY(angle);
      g.translate(w.a[0] + ux * mid, z0 + h / 2, w.a[1] + uy * mid);
      if (solid) {
        const pos = g.getAttribute("position");
        const nor = g.getAttribute("normal");
        const colors = new Float32Array(pos.count * 3);
        for (let f = 0; f < pos.count; f += 4) {
          n.fromBufferAttribute(nor, f);
          let c = top;
          if (Math.abs(n.y) < 0.5) {
            tmp.set(0, 0, 0);
            for (let k = 0; k < 4; k++) tmp.add(new THREE.Vector3().fromBufferAttribute(pos, f + k));
            tmp.multiplyScalar(0.25).addScaledVector(n, 0.2);
            const r = roomAt(plan, [tmp.x, tmp.z]);
            c = r ? roomColor.get(r.id)! : facade;
          }
          for (let k = 0; k < 4; k++) colors.set([c.r, c.g, c.b], (f + k) * 3);
        }
        g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        solids.push(g);
        if (opts.isTop && w.exterior && p.z1 >= H - 1e-3) {
          const pg = new THREE.BoxGeometry(len, 0.5, w.thickness);
          pg.rotateY(angle);
          pg.translate(w.a[0] + ux * mid, H + S + 0.25, w.a[1] + uy * mid);
          const cols = new Float32Array(pg.getAttribute("position").count * 3);
          for (let i = 0; i < cols.length; i += 3) cols.set([facade.r, facade.g, facade.b], i);
          pg.setAttribute("color", new THREE.BufferAttribute(cols, 3));
          parapets.push(pg);
        }
      } else glass.push(g);
    }
  }

  const rooms = plan.rooms
    .filter((r) => r.polygon.length >= 3)
    .map((r) => ({
      id: r.id,
      type: r.type,
      geometry: flat(r.polygon, 0.005),
      ceiling: (() => {
        const g = flat(r.polygon, H - 0.002);
        g.rotateX(Math.PI); // face down
        g.translate(0, 2 * (H - 0.002), 0);
        return g;
      })(),
      color: r.materials?.floor?.color ?? (["bathroom", "wc"].includes(r.type) ? "#ddd8cf" : "#c9b59a"),
      kind: r.materials?.floor?.kind ?? (["bathroom", "wc"].includes(r.type) ? "tile" : "wood"),
      textureKey: r.materials?.floor?.textureKey,
    }));

  const slabs = plan.rooms.filter((r) => r.polygon.length >= 3).map((r) => slab(r.polygon, H, S));

  return {
    walls: solids.length ? mergeGeometries(solids, false) : null,
    glass: glass.length ? mergeGeometries(glass, false) : null,
    parapet: parapets.length ? mergeGeometries(parapets, false) : null,
    rooms,
    roof: slabs.length ? mergeGeometries(slabs.map((g) => g.toNonIndexed()), false) : null,
    height: H + S,
  };
}

/** Under-floor slab for the ground floor (and visible slab edges on stacked floors). */
export function floorSlab(plan: PlanSpec): THREE.BufferGeometry | null {
  const gs = plan.rooms.filter((r) => r.polygon.length >= 3).map((r) => slab(r.polygon, -plan.slabThickness, plan.slabThickness).toNonIndexed());
  return gs.length ? mergeGeometries(gs, false) : null;
}
