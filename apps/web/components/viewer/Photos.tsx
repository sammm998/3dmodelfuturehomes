"use client";
import { useEffect, useMemo, useState } from "react";
import { useViewer } from "@/lib/store";
import type { MediaRef, Property } from "@/lib/types";

/**
 * The listing's REAL photos, shown where they belong: exterior photos next to the exterior model,
 * and in walk / dollhouse mode the photos matched to the room you are looking at.
 */
export function RealPhotos({ property }: { property: Property }) {
  const { mode, walkRoom, selectedHotspot, floorIndex } = useViewer();
  const [open, setOpen] = useState<number | null>(null);
  const b = property.buildings[0];
  const exterior = useMemo(() => {
    const ids = b?.massing?.photoMediaIds ?? [];
    const ext = property.media.filter((m) => m.classification?.class === "exterior");
    return [...ext].sort((x, y) => (ids.indexOf(x.id) === -1 ? 99 : ids.indexOf(x.id)) - (ids.indexOf(y.id) === -1 ? 99 : ids.indexOf(y.id)));
  }, [property, b]);

  const { photos, label } = useMemo((): { photos: MediaRef[]; label: string } => {
    if (mode === "exterior") return { photos: exterior, label: "Real photos" };
    const floors = b?.floors ?? [];
    let room = null as null | (typeof floors)[number]["rooms"][number];
    if (mode === "walk" && walkRoom) room = floors.find((f) => f.id === walkRoom.floorId)?.rooms.find((r) => r.planRoomId === walkRoom.planRoomId) ?? null;
    if (mode === "dollhouse" && selectedHotspot) {
      const h = property.hotspots.find((x) => x.id === selectedHotspot);
      if (h?.roomId) room = floors.flatMap((f) => f.rooms).find((r) => r.id === h.roomId) ?? null;
    }
    if (room) return { photos: property.media.filter((m) => m.roomId === room!.id), label: room.name };
    if (mode === "dollhouse") {
      const floor = floors.filter((f) => f.plan)[floorIndex];
      return { photos: property.media.filter((m) => m.floorId === floor?.id && m.roomId && m.classification?.class === "interior"), label: floor?.name ?? "" };
    }
    return { photos: [], label: "" };
  }, [mode, walkRoom, selectedHotspot, floorIndex, exterior, property, b]);

  useEffect(() => setOpen(null), [label]);
  if (!photos.length || mode === "plan" || mode === "pano") return null;
  return (
    <>
      <div className="pv-photos" aria-label="Real photos">
        <span className="pv-photos-label">
          {label} · <em>real photo{photos.length > 1 ? "s" : ""}</em>
        </span>
        <div className="pv-photos-strip">
          {photos.slice(0, 6).map((m, i) => (
            <button key={m.id} onClick={() => setOpen(i)} style={{ backgroundImage: `url(${m.thumbUrl})` }} aria-label={`Open photo ${i + 1}`} />
          ))}
          {photos.length > 6 && (
            <button className="more" onClick={() => setOpen(6)}>
              +{photos.length - 6}
            </button>
          )}
        </div>
      </div>
      {open !== null && (
        <div className="pv-lightbox" onClick={() => setOpen(null)}>
          <img src={photos[open].url} alt={label} onClick={(e) => e.stopPropagation()} />
          <button className="nav prev" onClick={(e) => (e.stopPropagation(), setOpen((open + photos.length - 1) % photos.length))}>
            ‹
          </button>
          <button className="nav next" onClick={(e) => (e.stopPropagation(), setOpen((open + 1) % photos.length))}>
            ›
          </button>
          <span className="cap">
            {label} · photo {open + 1} / {photos.length}
          </span>
        </div>
      )}
    </>
  );
}
