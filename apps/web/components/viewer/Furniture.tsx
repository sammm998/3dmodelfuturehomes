"use client";
import { useMemo } from "react";
import * as THREE from "three";
import type { FurnitureItem } from "@pv/shared";

/**
 * Illustrative furniture. Rendered with low-poly procedural primitives so it works offline;
 * drop CC0 GLBs into the library (see README) to replace them per kind.
 */
const PALETTE = {
  fabric: "#d9d3c7",
  fabricDark: "#8c8478",
  wood: "#a27a52",
  white: "#f6f5f2",
  stone: "#cfc8bc",
  metal: "#5a5a5a",
  green: "#5f7c4f",
  rug: "#bfb4a3",
};

type Part = { size: [number, number, number]; pos: [number, number, number]; color: string; round?: boolean };

function parts(it: FurnitureItem): Part[] {
  const { w, d, h } = it;
  switch (it.kind) {
    case "bed":
      return [
        { size: [w, 0.3, d], pos: [0, 0.15, 0], color: PALETTE.wood },
        { size: [w - 0.05, 0.22, d - 0.1], pos: [0, 0.41, 0.03], color: PALETTE.white },
        { size: [w, 0.9, 0.08], pos: [0, 0.45, -d / 2 + 0.04], color: PALETTE.fabricDark },
        { size: [w * 0.4, 0.12, 0.35], pos: [-w * 0.24, 0.58, -d / 2 + 0.3], color: PALETTE.white },
        { size: [w * 0.4, 0.12, 0.35], pos: [w * 0.24, 0.58, -d / 2 + 0.3], color: PALETTE.white },
        { size: [w - 0.02, 0.05, d * 0.45], pos: [0, 0.54, d * 0.2], color: PALETTE.fabric },
      ];
    case "sofa":
      return [
        { size: [w, 0.42, d], pos: [0, 0.21, 0], color: PALETTE.fabric },
        { size: [w, 0.45, 0.2], pos: [0, 0.62, -d / 2 + 0.1], color: PALETTE.fabric },
        { size: [0.18, 0.25, d], pos: [-w / 2 + 0.09, 0.55, 0], color: PALETTE.fabric },
        { size: [0.18, 0.25, d], pos: [w / 2 - 0.09, 0.55, 0], color: PALETTE.fabric },
      ];
    case "rug":
      return [{ size: [w, 0.01, d], pos: [0, 0.012, 0], color: PALETTE.rug }];
    case "coffee_table":
    case "dining_table":
    case "desk":
      return [
        { size: [w, 0.04, d], pos: [0, h - 0.02, 0], color: it.kind === "coffee_table" ? PALETTE.stone : PALETTE.wood },
        { size: [0.05, h - 0.04, 0.05], pos: [-w / 2 + 0.06, (h - 0.04) / 2, -d / 2 + 0.06], color: PALETTE.metal },
        { size: [0.05, h - 0.04, 0.05], pos: [w / 2 - 0.06, (h - 0.04) / 2, -d / 2 + 0.06], color: PALETTE.metal },
        { size: [0.05, h - 0.04, 0.05], pos: [-w / 2 + 0.06, (h - 0.04) / 2, d / 2 - 0.06], color: PALETTE.metal },
        { size: [0.05, h - 0.04, 0.05], pos: [w / 2 - 0.06, (h - 0.04) / 2, d / 2 - 0.06], color: PALETTE.metal },
      ];
    case "chair":
      return [
        { size: [w, 0.05, d], pos: [0, 0.45, 0], color: PALETTE.fabricDark },
        { size: [w, 0.45, 0.05], pos: [0, 0.68, -d / 2 + 0.03], color: PALETTE.fabricDark },
        { size: [0.04, 0.45, 0.04], pos: [-w / 2 + 0.04, 0.22, d / 2 - 0.04], color: PALETTE.metal },
        { size: [0.04, 0.45, 0.04], pos: [w / 2 - 0.04, 0.22, d / 2 - 0.04], color: PALETTE.metal },
        { size: [0.04, 0.45, 0.04], pos: [-w / 2 + 0.04, 0.22, -d / 2 + 0.04], color: PALETTE.metal },
        { size: [0.04, 0.45, 0.04], pos: [w / 2 - 0.04, 0.22, -d / 2 + 0.04], color: PALETTE.metal },
      ];
    case "counter":
    case "island":
      return [
        { size: [w, h - 0.04, d], pos: [0, (h - 0.04) / 2, 0], color: PALETTE.white },
        { size: [w + 0.02, 0.04, d + 0.02], pos: [0, h - 0.02, 0], color: PALETTE.stone },
      ];
    case "fridge":
    case "wardrobe":
    case "tv_unit":
    case "nightstand":
      return [{ size: [w, h, d], pos: [0, h / 2, 0], color: it.kind === "fridge" ? "#dfe2e4" : it.kind === "tv_unit" ? PALETTE.wood : PALETTE.white }];
    case "bathtub":
      return [{ size: [w, h, d], pos: [0, h / 2, 0], color: PALETTE.white }];
    case "shower":
      return [
        { size: [w, 0.05, d], pos: [0, 0.025, 0], color: PALETTE.white },
        { size: [0.01, 2, d], pos: [w / 2, 1, 0], color: "#cfe0ea" },
      ];
    case "toilet":
      return [
        { size: [w, 0.4, d * 0.65], pos: [0, 0.2, d * 0.1], color: PALETTE.white },
        { size: [w, 0.35, 0.18], pos: [0, 0.55, -d / 2 + 0.09], color: PALETTE.white },
      ];
    case "sink":
      return [
        { size: [w, 0.5, d], pos: [0, 0.6, 0], color: PALETTE.wood },
        { size: [w, 0.05, d], pos: [0, 0.87, 0], color: PALETTE.white },
      ];
    case "plant":
      return [
        { size: [0.35, 0.4, 0.35], pos: [0, 0.2, 0], color: "#b9a990" },
        { size: [w, h - 0.4, d], pos: [0, 0.4 + (h - 0.4) / 2, 0], color: PALETTE.green, round: true },
      ];
    case "lounger":
      return [{ size: [w, 0.3, d], pos: [0, 0.2, 0], color: PALETTE.white }];
    default:
      return [{ size: [w, h, d], pos: [0, h / 2, 0], color: PALETTE.fabric }];
  }
}

export function Furniture({ items, clip }: { items: FurnitureItem[]; clip: THREE.Plane[] }) {
  // one merged geometry per colour keeps draw calls low
  const meshes = useMemo(() => {
    const byColor = new Map<string, THREE.BufferGeometry[]>();
    for (const it of items) {
      for (const p of parts(it)) {
        const g = p.round ? new THREE.SphereGeometry(p.size[0] / 2, 10, 8).scale(1, p.size[1] / p.size[0], 1) : new THREE.BoxGeometry(...p.size);
        g.translate(...p.pos);
        g.rotateY(it.rot);
        g.translate(it.x, 0, it.y);
        const geo = g.index ? g.toNonIndexed() : g;
        geo.deleteAttribute("uv");
        byColor.set(p.color, [...(byColor.get(p.color) ?? []), geo]);
      }
    }
    return [...byColor.entries()].map(([color, gs]) => ({ color, geometry: mergeAll(gs) }));
  }, [items]);
  return (
    <group name="furniture">
      {meshes.map((m) => (
        <mesh key={m.color} geometry={m.geometry} castShadow receiveShadow>
          <meshStandardMaterial color={m.color} roughness={0.8} clippingPlanes={clip} />
        </mesh>
      ))}
    </group>
  );
}

function mergeAll(gs: THREE.BufferGeometry[]) {
  let count = 0;
  for (const g of gs) count += g.getAttribute("position").count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of gs) {
    pos.set(g.getAttribute("position").array as Float32Array, o * 3);
    nor.set(g.getAttribute("normal").array as Float32Array, o * 3);
    o += g.getAttribute("position").count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  m.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return m;
}
