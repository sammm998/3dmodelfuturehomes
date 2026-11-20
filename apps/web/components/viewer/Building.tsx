"use client";
import { useMemo } from "react";
import * as THREE from "three";
import { layoutFurniture, planBounds, type FacadeSpec, type PlanSpec } from "@pv/shared";
import { DEFAULT_FACADE, ExteriorDetails } from "./Exterior";
import type { BuildingRef, ViewMode } from "@/lib/types";
import { Furniture } from "./Furniture";
import { buildFloorGeometry, floorSlab } from "./planMesh";
import { floorTexture } from "./textures";

export interface StackedFloor {
  id: string;
  name: string;
  level: number;
  elevation: number;
  plan: PlanSpec;
}

export function stackFloors(b: BuildingRef | undefined): StackedFloor[] {
  if (!b) return [];
  return b.floors.filter((f) => f.plan).map((f) => ({ id: f.id, name: f.name, level: f.level, elevation: f.elevation, plan: f.plan! }));
}

interface Props {
  building: BuildingRef;
  floors: StackedFloor[];
  mode: ViewMode;
  floorIndex: number;
  cutHeight: number;
  showFurniture: boolean;
  /** used by the AR/preview to render a lighter version */
  simple?: boolean;
}

export function Building({ building, floors, mode, floorIndex, cutHeight, showFurniture, simple }: Props) {
  const spec: FacadeSpec = useMemo(
    () => ({ ...DEFAULT_FACADE, wallColor: building.massing?.facadeColor ?? DEFAULT_FACADE.wallColor, ...(building.massing?.facade ?? {}) }),
    [building.massing],
  );
  const facade = spec.wallColor;
  const topIdx = floors.length - 1;
  return (
    <group>
      {floors.map((f, i) => {
        const visible = mode === "exterior" || mode === "walk" || i <= floorIndex;
        if (!visible) return null;
        const selected = i === floorIndex;
        const cut =
          (mode === "dollhouse" && selected) || mode === "plan" ? (mode === "plan" ? 1.25 : cutHeight) : null;
        return (
          <FloorMesh
            key={f.id}
            floor={f}
            facade={facade}
            isTop={i === topIdx}
            showCeiling={mode === "walk" || (mode === "exterior") || (mode === "dollhouse" && !selected && i < floorIndex)}
            showRoof={mode === "exterior" && i === topIdx}
            cutAt={cut !== null ? f.elevation + cut : null}
            dim={(mode === "dollhouse" || mode === "plan") && !selected}
            showFurniture={showFurniture && !simple && (mode !== "exterior")}
            spec={spec}
            level={i}
            showDetails={!simple && (mode === "exterior" || mode === "walk")}
          />
        );
      })}
      <ContextFloors building={building} floors={floors} mode={mode} floorIndex={floorIndex} />
    </group>
  );
}

function FloorMesh({
  floor,
  facade,
  isTop,
  showCeiling,
  showRoof,
  cutAt,
  dim,
  showFurniture,
  spec,
  level,
  showDetails,
}: {
  spec: FacadeSpec;
  level: number;
  showDetails: boolean;
  floor: StackedFloor;
  facade: string;
  isTop: boolean;
  showCeiling: boolean;
  showRoof: boolean;
  cutAt: number | null;
  dim: boolean;
  showFurniture: boolean;
}) {
  const geo = useMemo(() => buildFloorGeometry(floor.plan, { facadeColor: facade, isTop }), [floor.plan, facade, isTop]);
  const slabGeo = useMemo(() => floorSlab(floor.plan), [floor.plan]);
  const furniture = useMemo(() => layoutFurniture(floor.plan), [floor.plan]);
  const clip = useMemo(() => (cutAt !== null ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), cutAt)] : []), [cutAt]);
  const wallMat = useMemo(
    () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: THREE.FrontSide }),
    [],
  );
  wallMat.clippingPlanes = clip;
  wallMat.clipShadows = true;
  wallMat.opacity = dim ? 0.55 : 1;
  wallMat.transparent = dim;
  wallMat.needsUpdate = true;

  return (
    <group position={[0, floor.elevation, 0]} name={`floor-${floor.level}`} userData={{ floorId: floor.id }}>
      {geo.walls && <mesh geometry={geo.walls} material={wallMat} castShadow receiveShadow />}
      {geo.glass && (
        <mesh geometry={geo.glass} renderOrder={2}>
          <meshStandardMaterial color="#58707f" transparent opacity={0.5} roughness={0.08} metalness={0.4} envMapIntensity={1.5} clippingPlanes={clip} depthWrite={false} />
        </mesh>
      )}
      {slabGeo && (
        <mesh geometry={slabGeo} receiveShadow>
          <meshStandardMaterial color="#d8d2c6" roughness={0.9} />
        </mesh>
      )}
      {geo.rooms.map((r) => (
        <mesh key={r.id} geometry={r.geometry} receiveShadow userData={{ walkable: true, roomId: r.id }} name="walkable">
          <meshStandardMaterial map={floorTexture(r.kind, r.color, r.textureKey)} roughness={r.kind === "tile" ? 0.35 : 0.7} transparent={dim} opacity={dim ? 0.6 : 1} />
        </mesh>
      ))}
      {showCeiling &&
        geo.rooms.map((r) => (
          <mesh key={`c-${r.id}`} geometry={r.ceiling}>
            <meshStandardMaterial color="#fbfaf7" roughness={1} />
          </mesh>
        ))}
      {showRoof && geo.roof && (
        <mesh geometry={geo.roof} castShadow receiveShadow>
          <meshStandardMaterial color={spec.roof === "flat" ? spec.roofColor : "#e7e1d7"} roughness={0.95} />
        </mesh>
      )}
      {showDetails && <ExteriorDetails plan={floor.plan} spec={spec} level={level} isTop={isTop} showRoof={showRoof} />}
      {showRoof && spec.roof === "flat" && geo.parapet && (
        <mesh geometry={geo.parapet} castShadow>
          <meshStandardMaterial vertexColors roughness={0.9} />
        </mesh>
      )}
      {showFurniture && <Furniture items={furniture} clip={clip} />}
    </group>
  );
}

/** Other storeys of an apartment building (no plan available): translucent illustrative massing. */
function ContextFloors({ building, floors, mode, floorIndex }: { building: BuildingRef; floors: StackedFloor[]; mode: ViewMode; floorIndex: number }) {
  const total = building.floorsCount;
  const geo = useMemo(() => {
    if (!floors.length || total <= floors.length) return null;
    const b = planBounds(floors[0].plan);
    const pad = 0.6;
    // apartments: suggest a building twice as wide as the unit
    const w = (b.w + pad) * (building.unitFloorIndex != null ? 2.1 : 1);
    const cx = building.unitFloorIndex != null ? b.minX - pad / 2 + w / 2 : (b.minX + b.maxX) / 2;
    return { w, d: b.h + pad, cx, cz: (b.minY + b.maxY) / 2, unitW: b.w + pad, unitCx: (b.minX + b.maxX) / 2 };
  }, [floors, total, building.unitFloorIndex]);
  if (!geo) return null;
  const storey = 3.1;
  const planLevels = new Set(floors.map((f) => f.level));
  const selectedLevel = floors[floorIndex]?.level ?? 0;
  const items: React.ReactElement[] = [];
  for (let lvl = 0; lvl < total; lvl++) {
    const isUnitLevel = planLevels.has(lvl);
    if ((mode === "dollhouse" || mode === "plan") && lvl > selectedLevel) continue;
    if (mode === "walk" && lvl > selectedLevel + 1) continue;
    const y = lvl * storey;
    // on the unit's own level only the neighbouring part of the building is massing
    const w = isUnitLevel ? geo.w - geo.unitW : geo.w;
    if (w <= 0.1) continue;
    const cx = isUnitLevel ? geo.cx + geo.unitW / 2 : geo.cx;
    items.push(
      <group key={lvl} position={[cx, y, geo.cz]}>
        <mesh position={[0, storey / 2 - 0.15, 0]} castShadow receiveShadow>
          <boxGeometry args={[w, storey - 0.3, geo.d]} />
          <meshStandardMaterial color="#e9eef2" transparent opacity={0.55} roughness={0.2} metalness={0.1} />
        </mesh>
        <mesh position={[0, storey - 0.15, 0]} castShadow receiveShadow>
          <boxGeometry args={[w + 0.3, 0.3, geo.d + 0.3]} />
          <meshStandardMaterial color="#f4f1ea" roughness={0.9} />
        </mesh>
      </group>,
    );
  }
  return <group>{items}</group>;
}

