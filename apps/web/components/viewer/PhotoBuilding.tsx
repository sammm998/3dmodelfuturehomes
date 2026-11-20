"use client";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import type { PhotoFacade } from "@pv/shared";
import { fileUrl } from "@/lib/api";
import type { BuildingRef } from "@/lib/types";

const STOREY = 3.2;

export interface PhotoDims {
  W: number;
  D: number;
  H: number;
  roofH: number;
  front: PhotoFacade;
  side: PhotoFacade | null;
  back: PhotoFacade | null;
}

/** Building volume sized from the rectified photos: height from the storey count, width/depth from facade aspect ratios. */
export function photoBuildingDims(b: BuildingRef | undefined): PhotoDims | null {
  const facades = (b?.massing?.photoFacades ?? []) as (PhotoFacade & { roofLine?: number })[];
  const front = facades.find((f) => f.side === "front") ?? facades[0];
  if (!front) return null;
  const side = facades.find((f) => f.side === "right" || f.side === "left") ?? null;
  const back = facades.find((f) => f.side === "back") ?? null;
  const storeys = Math.max(1, Math.round(b?.massing?.facade?.storeys || b?.floorsCount || 2));
  const H = storeys * STOREY;
  const W = THREE.MathUtils.clamp(H * front.aspect, 5, 90);
  // rectified side views are foreshortened by perspective, so never trust a very thin depth
  const D = THREE.MathUtils.clamp(side ? Math.max(H * side.aspect, W * 0.6) : W * 0.75, 5, 90);
  const roofH = H * (1 - Math.min(0.35, (front as any).roofLine ?? 0));
  return { W, D, H, roofH, front, side, back };
}

function useTex(key: string | undefined) {
  const [t, setT] = useState<THREE.Texture | null>(null);
  useEffect(() => {
    if (!key) return setT(null);
    let alive = true;
    new THREE.TextureLoader().load(fileUrl(key)!, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      if (alive) setT(tex);
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return t;
}

/**
 * Exterior made from the listing's own photos: each facade is the rectified photo of that side,
 * mapped onto a simple volume. Looks like the photos from similar angles; geometry is approximate.
 */
export function PhotoBuilding({ dims, center, fallbackColor, roofColor }: { dims: PhotoDims; center: [number, number]; fallbackColor: string; roofColor: string }) {
  const front = useTex(dims.front.key);
  const side = useTex(dims.side?.key);
  const back = useTex(dims.back?.key);
  const { W, D, H, roofH } = dims;
  const y0 = -0.25;
  const mat = (t: THREE.Texture | null, mirror = false) => {
    if (t && mirror) {
      const c = t.clone();
      c.wrapS = THREE.RepeatWrapping;
      c.repeat.x = -1;
      c.needsUpdate = true;
      t = c;
    }
    return t ? (
      // photos already contain their lighting: unlit, so they are not lit twice
      <meshBasicMaterial map={t} alphaTest={0.5} toneMapped={false} />
    ) : (
      <meshStandardMaterial color={fallbackColor} roughness={0.9} side={THREE.DoubleSide} />
    );
  };
  const faces = useMemo(
    () => [
      { key: "front", pos: [0, y0 + H / 2, D / 2] as const, rot: 0, w: W, tex: front, mirror: false },
      { key: "back", pos: [0, y0 + H / 2, -D / 2] as const, rot: Math.PI, w: W, tex: back ?? front, mirror: !back },
      { key: "right", pos: [W / 2, y0 + H / 2, 0] as const, rot: Math.PI / 2, w: D, tex: side, mirror: false },
      { key: "left", pos: [-W / 2, y0 + H / 2, 0] as const, rot: -Math.PI / 2, w: D, tex: side, mirror: true },
    ],
    [W, D, H, front, side, back],
  );
  return (
    <group position={[center[0], 0, center[1]]} name="photo-building">
      {faces.map((f) => (
        <mesh key={f.key} position={f.pos as any} rotation-y={f.rot}>
          <planeGeometry args={[f.w, H]} />
          {mat(f.tex, f.mirror)}
        </mesh>
      ))}
      {/* roof slab below a curved/stepped crown, plus an inner shell so the volume reads solid */}
      <mesh position={[0, y0 + roofH, 0]} rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[W - 0.05, D - 0.05]} />
        <meshStandardMaterial color={roofColor} roughness={0.95} />
      </mesh>
      <mesh position={[0, y0 + roofH / 2, 0]}>
        <boxGeometry args={[W - 0.3, roofH - 0.05, D - 0.3]} />
        <meshStandardMaterial color="#3c4148" roughness={1} />
      </mesh>
    </group>
  );
}
