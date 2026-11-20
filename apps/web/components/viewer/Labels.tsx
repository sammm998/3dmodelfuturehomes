"use client";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { polygonCentroid, roomAdjacency, type Vec2 } from "@pv/shared";
import { track } from "@/lib/analytics";
import type { ViewerState } from "@/lib/store";
import { useViewer } from "@/lib/store";
import type { Property } from "@/lib/types";
import type { StackedFloor } from "./Building";

/**
 * World-anchored labels (hotspots, plan labels, 360° links) rendered as ONE plain DOM layer
 * over the canvas and positioned every frame by <LabelProjector/>. This avoids per-label React
 * roots (drei <Html>) and keeps hundreds of labels cheap.
 */
export interface Anchor {
  id: string;
  pos: [number, number, number];
  kind: "hotspot" | "plan" | "pano" | "tag";
  hotspotKind?: string;
  title: string;
  body?: string | null;
  action?: () => void;
}

const els = new Map<string, HTMLElement>();
const v = new THREE.Vector3();

export function computeAnchors(property: Property, floors: StackedFloor[], s: Pick<ViewerState, "mode" | "floorIndex" | "showHotspots" | "panoRoomId">, poolPos: [number, number, number] | null): Anchor[] {
  const out: Anchor[] = [];
  const current = floors[s.floorIndex];
  if (s.mode === "pano") return panoLinks(property, floors, s.panoRoomId);
  if (s.mode === "plan" && current) {
    for (const r of current.plan.rooms) {
      const [x, z] = polygonCentroid(r.polygon);
      out.push({ id: `pl-${current.id}-${r.id}`, pos: [x, current.elevation + 0.1, z], kind: "plan", title: r.name, body: `${r.areaM2} m²` });
    }
    return out;
  }
  if (!s.showHotspots) return out;
  const visibleFloorIds = new Set(floors.filter((_, i) => (s.mode === "walk" ? i === s.floorIndex : i <= s.floorIndex)).map((f) => f.id));
  for (const h of property.hotspots) {
    let show: boolean;
    if (s.mode === "exterior") show = ["price", "view", "amenity", "availability"].includes(h.kind);
    else if (s.mode === "dollhouse") show = h.kind === "room" ? h.floorId === current?.id : !h.floorId || visibleFloorIds.has(h.floorId);
    else show = h.floorId ? visibleFloorIds.has(h.floorId) && h.kind !== "amenity" : false;
    if (!show) continue;
    out.push({ id: h.id, pos: h.position, kind: "hotspot", hotspotKind: h.kind, title: h.title, body: h.body });
  }
  if (poolPos && s.mode === "exterior") out.push({ id: "pool-tag", pos: poolPos, kind: "tag", title: "Pool · indicative" });
  return out;
}

function panoLinks(property: Property, floors: StackedFloor[], roomId: string | null): Anchor[] {
  const b = property.buildings[0];
  const rooms = b.floors.flatMap((f) => f.rooms.map((r) => ({ ...r, floorId: f.id })));
  const room = rooms.find((r) => r.id === roomId);
  const sf = room && floors.find((f) => f.id === room.floorId);
  const me = sf?.plan.rooms.find((r) => r.id === room!.planRoomId);
  if (!room || !sf || !me) return [];
  const c = polygonCentroid(me.polygon);
  const adj = roomAdjacency(sf.plan);
  const out: Anchor[] = [];
  for (const pid of adj.get(me.id) ?? []) {
    const other = rooms.find((r) => r.floorId === room.floorId && r.planRoomId === pid);
    if (!other?.artifacts.some((a) => a.kind === "panorama")) continue;
    const pr = sf.plan.rooms.find((r) => r.id === pid)!;
    const oc = polygonCentroid(pr.polygon);
    const d = Math.hypot(oc[0] - c[0], oc[1] - c[1]) || 1;
    const dir: Vec2 = [(oc[0] - c[0]) / d, (oc[1] - c[1]) / d];
    out.push({
      id: `pano-${other.id}`,
      pos: [c[0] + dir[0] * 6, sf.elevation + 0.4, c[1] + dir[1] * 6],
      kind: "pano",
      title: `→ ${pr.name}`,
      action: () => useViewer.setState({ panoRoomId: other.id }),
    });
  }
  return out;
}

/** Inside the Canvas: project anchors to screen space every frame. */
export function LabelProjector({ anchors }: { anchors: Anchor[] }) {
  const { camera, size } = useThree();
  useFrame(() => {
    for (const a of anchors) {
      const el = els.get(a.id);
      if (!el) continue;
      v.set(a.pos[0], a.pos[1], a.pos[2]);
      const dist = v.distanceTo(camera.position);
      v.project(camera);
      const hidden = v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2 || (a.kind === "hotspot" && dist < 0.9);
      if (hidden) {
        el.style.visibility = "hidden";
        continue;
      }
      el.style.visibility = "visible";
      el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * size.width}px, ${((1 - v.y) / 2) * size.height}px)`;
      el.style.zIndex = String(Math.round((1 - v.z) * 1000));
    }
  });
  return null;
}

/** Outside the Canvas: the label elements themselves. */
export function LabelLayer({ anchors, slug }: { anchors: Anchor[]; slug: string }) {
  const selected = useViewer((s) => s.selectedHotspot);
  return (
    <div className="pv-labels">
      {anchors.map((a) => (
        <div
          key={a.id}
          className="pv-anchor"
          style={{ visibility: "hidden" }}
          ref={(el) => {
            if (el) els.set(a.id, el);
            else els.delete(a.id);
          }}
        >
          {a.kind === "plan" && (
            <div className="pv-plan-label">
              <strong>{a.title}</strong>
              <span>{a.body}</span>
            </div>
          )}
          {a.kind === "tag" && <span className="pv-tag">{a.title}</span>}
          {a.kind === "pano" && (
            <button className="pv-pano-link" onClick={a.action}>
              {a.title}
            </button>
          )}
          {a.kind === "hotspot" && (
            <button
              className={`pv-hotspot pv-hotspot-${a.hotspotKind} ${selected === a.id ? "is-open" : ""}`}
              onClick={() => {
                useViewer.setState({ selectedHotspot: selected === a.id ? null : a.id });
                track(slug, "hotspot", { id: a.id, kind: a.hotspotKind, title: a.title });
              }}
            >
              <span className="dot" />
              <span className="label">{a.title}</span>
              {selected === a.id && a.body && <span className="body">{a.body}</span>}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
