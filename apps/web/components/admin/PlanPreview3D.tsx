"use client";
import { Environment, Lightformer, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useMemo } from "react";
import type { PlanSpec } from "@pv/shared";
import type { BuildingRef } from "@/lib/types";
import { Building } from "../viewer/Building";
import { sceneBounds } from "../viewer/Scene";

/** Live dollhouse preview of the plan being edited. */
export default function PlanPreview3D({ plan, building }: { plan: PlanSpec; building: BuildingRef }) {
  const floors = useMemo(() => [{ id: "edit", name: "Edit", level: 0, elevation: 0, plan }], [plan]);
  const b = sceneBounds(floors);
  const D = Math.max(b.w, b.d, 8);
  const editBuilding = useMemo(() => ({ ...building, floorsCount: 1, unitFloorIndex: null }), [building]);
  return (
    <Canvas shadows camera={{ position: [b.cx + D * 0.7, D * 1.1, b.cz + D * 0.9], fov: 45 }} gl={{ localClippingEnabled: true } as any}>
      <color attach="background" args={["#eef1f5"]} />
      <hemisphereLight args={["#ffffff", "#9a9184", 0.8]} />
      <directionalLight position={[10, 20, 8]} intensity={2} castShadow />
      <Environment resolution={64} frames={1}>
        <Lightformer intensity={2} position={[0, 6, 0]} rotation-x={Math.PI / 2} scale={[20, 20, 1]} />
      </Environment>
      <Building building={editBuilding} floors={floors} mode="dollhouse" floorIndex={0} cutHeight={2.2} showFurniture />
      <OrbitControls target={[b.cx, 0.5, b.cz]} makeDefault />
    </Canvas>
  );
}
