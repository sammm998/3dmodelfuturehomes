"use client";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import QRCode from "qrcode";
import { PROVENANCE_LABEL, weakestProvenance, type Provenance } from "@pv/shared";
import { track } from "@/lib/analytics";
import { money } from "@/lib/api";
import { useViewer } from "@/lib/store";
import type { Property, ViewMode } from "@/lib/types";
import { stackFloors } from "./Building";
import { computeAnchors, LabelLayer } from "./Labels";
import { RealPhotos } from "./Photos";
import { poolPosition, sceneBounds, SceneRoot, xrStore } from "./Scene";
import { walkInput } from "./walkInput";

type Variant = "full" | "embed" | "booth";

const MODES: { key: ViewMode; label: string; icon: string }[] = [
  { key: "exterior", label: "Exterior", icon: "⌂" },
  { key: "dollhouse", label: "Dollhouse", icon: "▣" },
  { key: "plan", label: "Floor plan", icon: "▦" },
  { key: "walk", label: "Walk", icon: "◉" },
  { key: "pano", label: "360°", icon: "◎" },
];

export default function ViewerApp({ property, variant = "full", publicUrl }: { property: Property; variant?: Variant; publicUrl: string }) {
  const building = property.buildings[0];
  const floors = useMemo(() => stackFloors(building), [building]);
  const bounds = useMemo(() => sceneBounds(floors, building?.floorsCount ?? 1, building?.unitFloorIndex ?? null), [floors, building]);
  const v = useViewer();
  const theme = property.agency?.theme;
  const panoRooms = useMemo(
    () => (building?.floors ?? []).flatMap((f) => f.rooms.filter((r) => r.artifacts.some((a) => a.kind === "panorama")).map((r) => ({ ...r, floorName: f.name }))),
    [building],
  );
  const hasSplat = property.artifacts.some((a) => a.kind === "splat");
  const hasPool = useMemo(
    () =>
      !!building?.massing?.facade?.pool ||
      property.features?.some((f) => /pool|piscina/i.test(f)) ||
      property.media.some((m) => m.classification?.amenity === "pool"),
    [property],
  );
  const anchors = useMemo(
    () =>
      computeAnchors(
        property,
        floors,
        { mode: v.mode, floorIndex: v.floorIndex, showHotspots: v.showHotspots, panoRoomId: v.panoRoomId },
        hasPool && floors.length ? (([x, , z]) => [x, 0.4, z] as [number, number, number])(poolPosition(floors, bounds)) : null,
      ),
    [property, floors, v.mode, v.floorIndex, v.showHotspots, v.panoRoomId, hasPool, bounds],
  );

  // initial state + analytics heartbeat (time in experience)
  useEffect(() => {
    useViewer.setState({ mode: "exterior", floorIndex: 0, booth: variant === "booth", tourPaused: false, panoRoomId: panoRooms[0]?.id ?? null });
    track(property.slug, "view", { variant });
    const id = setInterval(() => document.visibilityState === "visible" && track(property.slug, "heartbeat"), 15000);
    return () => clearInterval(id);
  }, [property.slug, variant, panoRooms]);

  // booth: pause the tour on interaction, resume after idle
  useEffect(() => {
    if (variant !== "booth") return;
    let t: ReturnType<typeof setTimeout>;
    const poke = () => {
      useViewer.setState({ tourPaused: true });
      clearTimeout(t);
      t = setTimeout(() => useViewer.setState({ tourPaused: false }), 45000);
    };
    window.addEventListener("pointerdown", poke);
    window.addEventListener("keydown", poke);
    return () => {
      window.removeEventListener("pointerdown", poke);
      window.removeEventListener("keydown", poke);
      clearTimeout(t);
    };
  }, [variant]);

  const style = {
    "--pv-primary": theme?.primary ?? "#1a365d",
    "--pv-accent": theme?.accent ?? "#c9a227",
    "--pv-bg": theme?.background ?? "#0b1526",
    "--pv-font-heading": theme?.fontHeading,
    "--pv-font-body": theme?.fontBody,
  } as React.CSSProperties;

  if (!floors.length)
    return (
      <div className="pv-viewer pv-empty" style={style}>
        <p>The 3D model for this property is still being built.</p>
      </div>
    );

  const provenance = currentProvenance(property, v.mode, v.showFurniture, v.photoreal, v.panoRoomId);

  return (
    <div className={`pv-viewer pv-${variant}`} style={style}>
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{ antialias: false, powerPreference: "high-performance", localClippingEnabled: true } as any}
        camera={{ position: [30, 20, 30], fov: 45, near: 0.05, far: 4000 }}
        onCreated={({ gl }) => {
          gl.localClippingEnabled = true;
          gl.toneMapping = THREE.NoToneMapping;
        }}
        onPointerMissed={() => v.set({ selectedHotspot: null })}
      >
        <SceneRoot property={property} floors={floors} bounds={bounds} embedded={variant === "embed"} anchors={anchors} />
      </Canvas>
      <LabelLayer anchors={anchors} slug={property.slug} />

      <header className="pv-top">
        <div className="pv-brand">
          {theme?.logoUrl ? <img src={theme.logoUrl} alt={property.agency?.name} /> : <span className="pv-brand-name">{property.agency?.name ?? "PropertyVerse"}</span>}
        </div>
        <div className="pv-title">
          <h1>{property.title}</h1>
          <p>
            {property.location}
            {property.location && " · "}
            <strong>{money(property.price, property.currency, property.priceText)}</strong>
          </p>
        </div>
        {variant !== "booth" && (
          <button className="pv-icon-btn" title="Fullscreen" onClick={() => toggleFullscreen()}>
            ⛶
          </button>
        )}
      </header>

      {variant !== "booth" && (
        <nav className="pv-modes" aria-label="View mode">
          {MODES.map((m) => {
            const disabled = m.key === "pano" && !panoRooms.length;
            return (
              <button
                key={m.key}
                className={v.mode === m.key ? "active" : ""}
                disabled={disabled}
                title={disabled ? "No 360° panoramas for this property yet" : m.label}
                onClick={() => {
                  if (m.key === "pano" && !v.panoRoomId) v.set({ panoRoomId: panoRooms[0]?.id ?? null });
                  v.setMode(m.key);
                }}
              >
                <span className="i">{m.icon}</span>
                <span className="t">{m.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {v.mode !== "pano" && floors.length > 0 && (building.floorsCount > 1 || floors.length > 1) && (
        <aside className="pv-floors" aria-label="Floor selector">
          {[...floors].map((f, i) => ({ f, i })).reverse().map(({ f, i }) => (
            <button
              key={f.id}
              className={v.floorIndex === i ? "active" : ""}
              onClick={() => {
                v.setFloor(i);
                if (v.mode === "exterior") v.setMode("dollhouse");
                track(property.slug, "floor_change", { floor: f.name });
              }}
            >
              <span className="lvl">{f.level === 0 ? "G" : f.level}</span>
              <span className="nm">{f.name}</span>
            </button>
          ))}
          {building.floorsCount > floors.length && <div className="pv-floors-note">{building.floorsCount} storeys in building</div>}
        </aside>
      )}

      {v.mode === "pano" && (
        <aside className="pv-floors pv-rooms">
          {panoRooms.map((r) => (
            <button key={r.id} className={v.panoRoomId === r.id ? "active" : ""} onClick={() => v.set({ panoRoomId: r.id })}>
              <span className="nm">{r.name}</span>
            </button>
          ))}
        </aside>
      )}

      <div className="pv-tools">
        {v.mode === "dollhouse" && (
          <label className="pv-slider">
            Cut
            <input type="range" min={0.6} max={3} step={0.05} value={v.cutHeight} onChange={(e) => v.set({ cutHeight: Number(e.target.value) })} />
          </label>
        )}
        {v.mode === "exterior" && (
          <label className="pv-slider" title="Sun position for the property's location">
            ☀ {String(Math.floor(v.sunHour)).padStart(2, "0")}:{String(Math.round((v.sunHour % 1) * 60)).padStart(2, "0")}
            <input type="range" min={6} max={21} step={0.25} value={v.sunHour} onChange={(e) => v.set({ sunHour: Number(e.target.value) })} />
          </label>
        )}
        {["dollhouse", "walk"].includes(v.mode) && (
          <button className={`pv-chip ${v.showFurniture ? "on" : ""}`} onClick={() => v.set({ showFurniture: !v.showFurniture })}>
            Furniture
          </button>
        )}
        {hasSplat && (
          <button className={`pv-chip ${v.photoreal ? "on" : ""}`} onClick={() => v.set({ photoreal: !v.photoreal })}>
            Photoreal
          </button>
        )}
        <button className={`pv-chip ${v.showHotspots ? "on" : ""}`} onClick={() => v.set({ showHotspots: !v.showHotspots })}>
          Info points
        </button>
      </div>

      <ProvenanceBadge p={provenance.level} parts={provenance.parts} />
      {variant !== "booth" && <RealPhotos property={property} />}

      {v.mode === "walk" && variant !== "booth" && <WalkHelp />}

      {variant === "full" && <InfoPanel property={property} />}
      {variant !== "booth" && <LeadBar property={property} publicUrl={publicUrl} compact={variant === "embed"} />}
      {variant === "booth" && <BoothOverlay property={property} publicUrl={publicUrl} />}
    </div>
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

function currentProvenance(property: Property, mode: ViewMode, furniture: boolean, photoreal: boolean, panoRoomId: string | null) {
  const b = property.buildings[0];
  const plans = b.floors.filter((f) => f.plan).map((f) => f.plan!.provenance);
  const parts: { label: string; p: Provenance }[] = [];
  if (mode === "pano") {
    const room = b.floors.flatMap((f) => f.rooms).find((r) => r.id === panoRoomId);
    const a = room?.artifacts.find((x) => x.kind === "panorama");
    if (a) parts.push({ label: a.meta?.method === "stitched" ? "Panorama stitched from photos" : "Panorama extended from a single photo", p: a.provenance });
  } else {
    parts.push({ label: plans.includes("illustrative") ? "Layout generated from listing data" : "Layout from floor plan", p: weakestProvenance(plans) });
    if (mode !== "exterior") parts.push({ label: "Floor materials & wall colours", p: "illustrative" });
    if (mode !== "exterior" && furniture) parts.push({ label: "Furniture", p: "illustrative" });
    if (mode === "exterior")
      parts.push({ label: b.massing?.facade ? "Facade & roof modelled from the listing photos" : "Facade, roof & surroundings", p: "illustrative" });
    if (b.floorsCount > b.floors.length) parts.push({ label: "Other storeys of the building", p: "illustrative" });
    if (photoreal) parts.push({ label: "Photoreal layer", p: property.artifacts.find((a) => a.kind === "splat")?.provenance ?? "reconstructed" });
  }
  return { level: weakestProvenance(parts.map((x) => x.p)), parts };
}

function ProvenanceBadge({ p, parts }: { p: Provenance; parts: { label: string; p: Provenance }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`pv-provenance pv-prov-${p}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onClick={() => setOpen(!open)}>
      <span className="pv-prov-pill">{PROVENANCE_LABEL[p].short}</span>
      {open && (
        <div className="pv-prov-pop">
          <p>{PROVENANCE_LABEL[p].long}</p>
          <ul>
            {parts.map((x) => (
              <li key={x.label}>
                <span>{x.label}</span>
                <em>{PROVENANCE_LABEL[x.p].short}</em>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function InfoPanel({ property }: { property: Property }) {
  const [open, setOpen] = useState(false);
  const { selectedHotspot } = useViewer();
  const hs = property.hotspots.find((h) => h.id === selectedHotspot);
  const unit = property.buildings[0]?.floors.flatMap((f) => f.units)[0];
  return (
    <section className={`pv-info ${open ? "open" : ""}`}>
      <button className="pv-info-toggle" onClick={() => setOpen(!open)}>
        {open ? "×" : "Details"}
      </button>
      {open && (
        <div className="pv-info-body">
          <dl className="pv-facts">
            {property.bedrooms != null && (
              <div>
                <dt>Bedrooms</dt>
                <dd>{property.bedrooms}</dd>
              </div>
            )}
            {property.bathrooms != null && (
              <div>
                <dt>Bathrooms</dt>
                <dd>{property.bathrooms}</dd>
              </div>
            )}
            {property.sqm != null && (
              <div>
                <dt>Size</dt>
                <dd>{property.sqm} m²</dd>
              </div>
            )}
            <div>
              <dt>Status</dt>
              <dd>{unit?.availability ?? property.availability ?? "Available"}</dd>
            </div>
          </dl>
          {unit && (
            <p className="pv-unit">
              Unit {unit.code} · {money(unit.price, property.currency)} · {unit.availability}
            </p>
          )}
          {hs && (
            <div className="pv-hs-detail">
              <h3>{hs.title}</h3>
              {hs.body && <p>{hs.body}</p>}
            </div>
          )}
          {property.description && <p className="pv-desc">{property.description}</p>}
          {property.features?.length > 0 && (
            <ul className="pv-features">
              {property.features.slice(0, 12).map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          {property.sourceUrl && (
            <a className="pv-source" href={property.sourceUrl} target="_blank" rel="noreferrer">
              View original listing ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
}

function LeadBar({ property, publicUrl, compact }: { property: Property; publicUrl: string; compact?: boolean }) {
  const [share, setShare] = useState(false);
  const wa = property.agency?.whatsapp?.replace(/[^\d]/g, "");
  const msg = encodeURIComponent(`Hello, I'm interested in "${property.title}" ${property.sourceUrl ?? publicUrl}`);
  const booking = property.agency?.bookingUrl;
  const [arOk, setArOk] = useState(false);
  useEffect(() => {
    (navigator as any).xr?.isSessionSupported?.("immersive-ar").then((ok: boolean) => setArOk(ok)).catch(() => {});
  }, []);
  return (
    <>
      <div className={`pv-leads ${compact ? "compact" : ""}`}>
        {wa && (
          <a className="pv-btn pv-btn-wa" href={`https://wa.me/${wa}?text=${msg}`} target="_blank" rel="noreferrer" onClick={() => track(property.slug, "lead_whatsapp")}>
            WhatsApp
          </a>
        )}
        <a
          className="pv-btn pv-btn-primary"
          href={booking ?? `mailto:?subject=${encodeURIComponent(`Viewing: ${property.title}`)}`}
          target="_blank"
          rel="noreferrer"
          onClick={() => track(property.slug, "lead_booking")}
        >
          Book a viewing
        </a>
        {!compact && (
          <button className="pv-btn" onClick={() => setShare(true)}>
            Share
          </button>
        )}
        {arOk && (
          <button
            className="pv-btn"
            onClick={() => {
              track(property.slug, "ar_start");
              xrStore.enterAR();
            }}
          >
            View in AR
          </button>
        )}
      </div>
      {share && <ShareModal property={property} publicUrl={publicUrl} onClose={() => setShare(false)} />}
    </>
  );
}

function ShareModal({ property, publicUrl, onClose }: { property: Property; publicUrl: string; onClose: () => void }) {
  const embedUrl = publicUrl.replace(`/p/${property.slug}`, `/embed/${property.slug}`);
  const iframe = `<iframe src="${embedUrl}" width="100%" height="600" style="border:0;border-radius:12px" allow="fullscreen; xr-spatial-tracking" allowfullscreen loading="lazy" title="${property.title.replace(/"/g, "&quot;")} – 3D tour"></iframe>`;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (t: string, what: string) => {
    await navigator.clipboard.writeText(t);
    setCopied(what);
    track(property.slug, what === "embed" ? "embed_copy" : "share", {});
  };
  return (
    <div className="pv-modal" onClick={onClose}>
      <div className="pv-modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>Share this 3D tour</h2>
        <label>Link</label>
        <div className="pv-copy">
          <input readOnly value={publicUrl} />
          <button onClick={() => copy(publicUrl, "link")}>{copied === "link" ? "Copied" : "Copy"}</button>
        </div>
        {"share" in navigator && (
          <button className="pv-btn" onClick={() => navigator.share({ title: property.title, url: publicUrl }).then(() => track(property.slug, "share", { native: true }))}>
            Share…
          </button>
        )}
        <label>Embed on your website</label>
        <div className="pv-copy">
          <textarea readOnly value={iframe} rows={4} />
          <button onClick={() => copy(iframe, "embed")}>{copied === "embed" ? "Copied" : "Copy"}</button>
        </div>
        <button className="pv-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function BoothOverlay({ property, publicUrl }: { property: Property; publicUrl: string }) {
  const [qr, setQr] = useState<string>("");
  const target = property.sourceUrl ?? publicUrl;
  useEffect(() => {
    QRCode.toDataURL(target, { margin: 1, width: 360, color: { dark: "#0b1526", light: "#ffffff" } }).then(setQr);
  }, [target]);
  const paused = useViewer((s) => s.tourPaused);
  return (
    <div className="pv-booth">
      <div className="pv-booth-card">
        {qr && <img src={qr} alt="QR code to the listing" />}
        <p>Scan to see the listing</p>
      </div>
      <div className="pv-booth-facts">
        {property.bedrooms != null && <span>{property.bedrooms} bed</span>}
        {property.bathrooms != null && <span>{property.bathrooms} bath</span>}
        {property.sqm != null && <span>{property.sqm} m²</span>}
      </div>
      {paused && <div className="pv-booth-paused">Exploring… the tour resumes automatically</div>}
      <button className="pv-booth-fs" onClick={toggleFullscreen} aria-label="Fullscreen">
        ⛶
      </button>
    </div>
  );
}

function WalkHelp() {
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(matchMedia("(pointer: coarse)").matches), []);
  return (
    <>
      {!touch && <div className="pv-walk-help">WASD / arrows to move · drag to look · click the floor to walk there · L locks the mouse</div>}
      {touch && (
        <>
          <Joystick side="left" onChange={(x, y) => ((walkInput.moveX = x), (walkInput.moveY = -y))} />
          <Joystick side="right" onChange={(x, y) => ((walkInput.lookX = x), (walkInput.lookY = y))} />
        </>
      )}
    </>
  );
}

function Joystick({ side, onChange }: { side: "left" | "right"; onChange: (x: number, y: number) => void }) {
  const base = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<[number, number]>([0, 0]);
  useEffect(() => () => onChange(0, 0), [onChange]);
  const handle = (e: React.PointerEvent) => {
    const r = base.current!.getBoundingClientRect();
    const R = r.width / 2;
    let x = (e.clientX - r.left - R) / R,
      y = (e.clientY - r.top - R) / R;
    const l = Math.hypot(x, y);
    if (l > 1) {
      x /= l;
      y /= l;
    }
    setKnob([x, y]);
    onChange(x, y);
  };
  return (
    <div
      ref={base}
      className={`pv-joy pv-joy-${side}`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        handle(e);
      }}
      onPointerMove={(e) => e.buttons && handle(e)}
      onPointerUp={() => {
        setKnob([0, 0]);
        onChange(0, 0);
      }}
    >
      <div className="knob" style={{ transform: `translate(${knob[0] * 32}px, ${knob[1] * 32}px)` }} />
    </div>
  );
}
