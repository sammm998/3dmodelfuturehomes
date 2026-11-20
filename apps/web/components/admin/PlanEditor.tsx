"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { planBounds, polygonArea, polygonCentroid, RoomType, type Opening, type PlanSpec, type Vec2, type Wall } from "@pv/shared";

type Tool = "select" | "wall" | "door" | "window" | "calibrate";
type Sel = { kind: "wall" | "opening" | "room"; id: string } | null;

const GRID = 0.05;
const SNAP = 0.3;
const snapGrid = (v: number) => Math.round(v / GRID) * GRID;
const uid = (p: string) => `${p}${Math.random().toString(36).slice(2, 8)}`;

/**
 * SVG floor plan editor (metres). Fix what the parser got wrong:
 * drag wall ends (connected walls move together), draw walls, add doors/windows, edit rooms,
 * calibrate the scale against a known length. Shift locks drawing to horizontal/vertical.
 */
export function PlanEditor({ plan: initial, onChange }: { plan: PlanSpec; onChange: (p: PlanSpec) => void }) {
  const [plan, setPlanState] = useState(initial);
  const [history, setHistory] = useState<PlanSpec[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const [showUnderlay, setShowUnderlay] = useState(true);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ targets: { type: "wall"; id: string; end: "a" | "b" }[] | { type: "room"; id: string; idx: number }[]; start: Vec2 } | null>(null);

  useEffect(() => setPlanState(initial), [initial]);

  const commit = useCallback(
    (next: PlanSpec, pushHistory = true) => {
      if (pushHistory) setHistory((h) => [...h.slice(-40), plan]);
      setPlanState(next);
      onChange(next);
    },
    [plan, onChange],
  );

  const view = useMemo(() => {
    const b = planBounds(initial);
    const m = 2;
    return { x: b.minX - m, y: b.minY - m, w: b.w + 2 * m, h: b.h + 2 * m };
  }, [initial]);

  const toPlan = (e: { clientX: number; clientY: number }): Vec2 => {
    const pt = svg.current!.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [p.x, p.y];
  };
  const endpoints = useMemo(() => plan.walls.flatMap((w) => [w.a, w.b]), [plan.walls]);
  const snap = (p: Vec2, exclude?: Vec2[]): Vec2 => {
    let best: Vec2 | null = null,
      bd = SNAP;
    for (const q of endpoints) {
      if (exclude?.some((x) => x === q)) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best ? [best[0], best[1]] : [snapGrid(p[0]), snapGrid(p[1])];
  };
  const axisLock = (a: Vec2, b: Vec2, shift: boolean): Vec2 => (shift ? (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]]) : b);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (sel.kind === "wall") commit({ ...plan, walls: plan.walls.filter((w) => w.id !== sel.id), openings: plan.openings.filter((o) => o.wallId !== sel.id) });
        if (sel.kind === "opening") commit({ ...plan, openings: plan.openings.filter((o) => o.id !== sel.id) });
        if (sel.kind === "room") commit({ ...plan, rooms: plan.rooms.filter((r) => r.id !== sel.id) });
        setSel(null);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && history.length) {
        const prev = history[history.length - 1];
        setHistory(history.slice(0, -1));
        setPlanState(prev);
        onChange(prev);
      }
      if (e.key === "Escape") {
        setDraft(null);
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, plan, history, commit, onChange]);

  // ---- pointer handling ----
  const onDown = (e: React.PointerEvent) => {
    const p = toPlan(e);
    if (tool === "wall" || tool === "calibrate") {
      const s = tool === "wall" ? snap(p) : p;
      setDraft({ a: s, b: s });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    } else if (tool === "select" && e.target === svg.current) setSel(null);
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toPlan(e);
    if (draft) {
      setDraft({ ...draft, b: axisLock(draft.a, tool === "wall" ? snap(p) : p, e.shiftKey) });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const exclude: Vec2[] = [];
    const sp = snap(p, exclude);
    const next = structuredClone(plan);
    for (const t of d.targets as any[]) {
      if (t.type === "wall") {
        const w = next.walls.find((x: Wall) => x.id === t.id)!;
        w[t.end as "a" | "b"] = [sp[0], sp[1]];
      } else {
        const r = next.rooms.find((x) => x.id === t.id)!;
        r.polygon[t.idx] = [sp[0], sp[1]];
        r.areaM2 = Math.round(polygonArea(r.polygon) * 10) / 10;
      }
    }
    setPlanState(next);
  };
  const onUp = () => {
    if (draft) {
      const L = Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1]);
      if (tool === "wall" && L > 0.2) {
        const w: Wall = { id: uid("w"), a: draft.a, b: draft.b, thickness: 0.12, exterior: false };
        commit({ ...plan, walls: [...plan.walls, w] });
        setSel({ kind: "wall", id: w.id });
      }
      if (tool === "calibrate" && L > 0.1) {
        const real = Number(prompt(`Drawn length is ${L.toFixed(2)} m on the current scale. Enter the real length in metres:`, L.toFixed(2)));
        if (real > 0) commit(scalePlan(plan, real / L));
        setTool("select");
      }
      setDraft(null);
      return;
    }
    if (drag.current) {
      drag.current = null;
      commit(plan, true);
    }
  };

  const startEndpointDrag = (e: React.PointerEvent, w: Wall, end: "a" | "b") => {
    e.stopPropagation();
    if (tool !== "select") return;
    const p = w[end];
    // move every wall end at this junction together
    const targets = plan.walls.flatMap((x) =>
      (["a", "b"] as const).filter((k) => Math.hypot(x[k][0] - p[0], x[k][1] - p[1]) < 0.02).map((k) => ({ type: "wall" as const, id: x.id, end: k })),
    );
    drag.current = { targets, start: p };
    setHistory((h) => [...h.slice(-40), plan]);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const clickWall = (e: React.PointerEvent, w: Wall) => {
    e.stopPropagation();
    if (tool === "door" || tool === "window") {
      const p = toPlan(e);
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const t = Math.max(0, Math.min(1, ((p[0] - w.a[0]) * (w.b[0] - w.a[0]) + (p[1] - w.a[1]) * (w.b[1] - w.a[1])) / (L * L)));
      const o: Opening =
        tool === "door"
          ? { id: uid("o"), wallId: w.id, type: "door", t, width: Math.min(0.9, L - 0.1), sill: 0, head: 2.1 }
          : { id: uid("o"), wallId: w.id, type: "window", t, width: Math.min(1.2, L - 0.2), sill: 0.9, head: 2.2 };
      commit({ ...plan, openings: [...plan.openings, o] });
      setSel({ kind: "opening", id: o.id });
      return;
    }
    if (tool === "select") setSel({ kind: "wall", id: w.id });
  };

  const selWall = sel?.kind === "wall" ? plan.walls.find((w) => w.id === sel.id) : undefined;
  const selOpening = sel?.kind === "opening" ? plan.openings.find((o) => o.id === sel.id) : undefined;
  const selRoom = sel?.kind === "room" ? plan.rooms.find((r) => r.id === sel.id) : undefined;
  const u = plan.underlay;
  const stroke = view.w / 400;

  const updateWall = (patch: Partial<Wall>) => commit({ ...plan, walls: plan.walls.map((w) => (w.id === selWall!.id ? { ...w, ...patch } : w)) });
  const updateOpening = (patch: Partial<Opening>) => commit({ ...plan, openings: plan.openings.map((o) => (o.id === selOpening!.id ? { ...o, ...patch } : o)) });
  const updateRoom = (patch: Partial<PlanSpec["rooms"][number]>) => commit({ ...plan, rooms: plan.rooms.map((r) => (r.id === selRoom!.id ? { ...r, ...patch } : r)) });

  return (
    <div className="pe">
      <div className="pe-toolbar">
        {(
          [
            ["select", "Select / move"],
            ["wall", "Draw wall"],
            ["door", "Add door"],
            ["window", "Add window"],
            ["calibrate", "Calibrate scale"],
          ] as const
        ).map(([t, l]) => (
          <button key={t} className={tool === t ? "on" : ""} onClick={() => setTool(t)}>
            {l}
          </button>
        ))}
        <button
          onClick={() => {
            const b = planBounds(plan);
            const r = { id: uid("r"), name: "New room", type: "other" as const, polygon: [[b.minX + 1, b.minY + 1], [b.minX + 4, b.minY + 1], [b.minX + 4, b.minY + 4], [b.minX + 1, b.minY + 4]] as Vec2[], areaM2: 9 };
            commit({ ...plan, rooms: [...plan.rooms, r] });
            setSel({ kind: "room", id: r.id });
          }}
        >
          Add room
        </button>
        <label className="pe-inline">
          <input type="checkbox" checked={showUnderlay} onChange={(e) => setShowUnderlay(e.target.checked)} /> Source plan
        </label>
        <label className="pe-inline">
          Ceiling
          <input type="number" step={0.05} min={2} max={6} value={plan.ceilingHeight} onChange={(e) => commit({ ...plan, ceilingHeight: Number(e.target.value) })} /> m
        </label>
        <span className="pe-hint">Del = delete · Ctrl+Z = undo · Shift = straight lines · Esc = cancel</span>
      </div>
      <div className="pe-body">
        <svg
          ref={svg}
          className={`pe-canvas tool-${tool}`}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
        >
          <defs>
            <pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
              <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#e3e7ee" strokeWidth={stroke * 0.6} />
            </pattern>
          </defs>
          <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#grid)" pointerEvents="none" />
          {showUnderlay && u?.url && (
            <image href={u.url} x={u.originM[0]} y={u.originM[1]} width={u.widthPx * u.metersPerPixel} height={u.heightPx * u.metersPerPixel} opacity={0.45} pointerEvents="none" />
          )}
          {plan.rooms.map((r) => {
            const c = polygonCentroid(r.polygon);
            const on = sel?.kind === "room" && sel.id === r.id;
            return (
              <g key={r.id}>
                <polygon
                  points={r.polygon.map((p) => p.join(",")).join(" ")}
                  className={`pe-room ${on ? "on" : ""}`}
                  onPointerDown={(e) => {
                    if (tool !== "select") return;
                    e.stopPropagation();
                    setSel({ kind: "room", id: r.id });
                  }}
                />
                <text x={c[0]} y={c[1]} className="pe-label" fontSize={Math.max(0.22, view.w / 70)} textAnchor="middle" pointerEvents="none">
                  {r.name}
                  <tspan x={c[0]} dy="1.2em" className="pe-sub">
                    {r.areaM2} m²
                  </tspan>
                </text>
                {on &&
                  r.polygon.map((p, i) => (
                    <circle
                      key={i}
                      cx={p[0]}
                      cy={p[1]}
                      r={stroke * 5}
                      className="pe-handle room"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        drag.current = { targets: [{ type: "room", id: r.id, idx: i }], start: p };
                        setHistory((h) => [...h.slice(-40), plan]);
                        (e.target as Element).setPointerCapture?.(e.pointerId);
                      }}
                    />
                  ))}
              </g>
            );
          })}
          {plan.walls.map((w) => (
            <line
              key={w.id}
              x1={w.a[0]}
              y1={w.a[1]}
              x2={w.b[0]}
              y2={w.b[1]}
              strokeWidth={w.thickness}
              className={`pe-wall ${w.exterior ? "ext" : ""} ${sel?.id === w.id ? "on" : ""}`}
              onPointerDown={(e) => clickWall(e, w)}
            />
          ))}
          {plan.openings.map((o) => {
            const w = plan.walls.find((x) => x.id === o.wallId);
            if (!w) return null;
            const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) || 1;
            const ux = (w.b[0] - w.a[0]) / L,
              uy = (w.b[1] - w.a[1]) / L;
            const cx = w.a[0] + ux * o.t * L,
              cy = w.a[1] + uy * o.t * L;
            return (
              <line
                key={o.id}
                x1={cx - (ux * o.width) / 2}
                y1={cy - (uy * o.width) / 2}
                x2={cx + (ux * o.width) / 2}
                y2={cy + (uy * o.width) / 2}
                strokeWidth={w.thickness * 1.25}
                className={`pe-opening ${o.type} ${sel?.id === o.id ? "on" : ""}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  if (tool === "select") setSel({ kind: "opening", id: o.id });
                }}
              />
            );
          })}
          {tool === "select" &&
            plan.walls.flatMap((w) =>
              (["a", "b"] as const).map((end) => (
                <circle key={`${w.id}${end}`} cx={w[end][0]} cy={w[end][1]} r={stroke * 4} className="pe-handle" onPointerDown={(e) => startEndpointDrag(e, w, end)} />
              )),
            )}
          {draft && (
            <>
              <line x1={draft.a[0]} y1={draft.a[1]} x2={draft.b[0]} y2={draft.b[1]} className={tool === "calibrate" ? "pe-measure" : "pe-draft"} strokeWidth={tool === "calibrate" ? stroke * 2 : 0.12} />
              <text x={draft.b[0]} y={draft.b[1] - stroke * 6} fontSize={view.w / 60} className="pe-len">
                {Math.hypot(draft.b[0] - draft.a[0], draft.b[1] - draft.a[1]).toFixed(2)} m
              </text>
            </>
          )}
        </svg>
        <div className="pe-side">
          {!sel && (
            <div>
              <h4>Plan</h4>
              <p className="muted">
                {plan.walls.length} walls · {plan.openings.length} openings · {plan.rooms.length} rooms
              </p>
              <p className="muted">
                Scale source: <b>{plan.scale.source}</b> · confidence {Math.round(plan.confidence * 100)}%
              </p>
              {plan.notes.map((n, i) => (
                <p key={i} className="note">
                  {n}
                </p>
              ))}
            </div>
          )}
          {selWall && (
            <div>
              <h4>Wall</h4>
              <label>
                Thickness (m)
                <input type="number" step={0.01} min={0.05} max={1} value={selWall.thickness} onChange={(e) => updateWall({ thickness: Number(e.target.value) })} />
              </label>
              <label className="pe-inline">
                <input type="checkbox" checked={selWall.exterior} onChange={(e) => updateWall({ exterior: e.target.checked })} /> Exterior wall
              </label>
              <p className="muted">Length {Math.hypot(selWall.b[0] - selWall.a[0], selWall.b[1] - selWall.a[1]).toFixed(2)} m</p>
            </div>
          )}
          {selOpening && (
            <div>
              <h4>Opening</h4>
              <label>
                Type
                <select value={selOpening.type} onChange={(e) => updateOpening({ type: e.target.value as Opening["type"], sill: e.target.value === "window" ? 0.9 : 0 })}>
                  {["door", "window", "opening", "sliding"].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Width (m)
                <input type="number" step={0.05} min={0.4} value={selOpening.width} onChange={(e) => updateOpening({ width: Number(e.target.value) })} />
              </label>
              <label>
                Position along wall
                <input type="range" min={0} max={1} step={0.005} value={selOpening.t} onChange={(e) => updateOpening({ t: Number(e.target.value) })} />
              </label>
              <label>
                Sill / head height (m)
                <span className="pe-pair">
                  <input type="number" step={0.05} value={selOpening.sill} onChange={(e) => updateOpening({ sill: Number(e.target.value) })} />
                  <input type="number" step={0.05} value={selOpening.head} onChange={(e) => updateOpening({ head: Number(e.target.value) })} />
                </span>
              </label>
            </div>
          )}
          {selRoom && (
            <div>
              <h4>Room</h4>
              <label>
                Name
                <input value={selRoom.name} onChange={(e) => updateRoom({ name: e.target.value })} />
              </label>
              <label>
                Type
                <select value={selRoom.type} onChange={(e) => updateRoom({ type: e.target.value as any })}>
                  {RoomType.options.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Area (m²)
                <input type="number" step={0.1} value={selRoom.areaM2} onChange={(e) => updateRoom({ areaM2: Number(e.target.value) })} />
              </label>
              <p className="muted">Drag the corner handles to reshape the room.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function scalePlan(plan: PlanSpec, k: number): PlanSpec {
  const s = (p: Vec2): Vec2 => [p[0] * k, p[1] * k];
  return {
    ...plan,
    walls: plan.walls.map((w) => ({ ...w, a: s(w.a), b: s(w.b), thickness: Math.max(0.05, w.thickness * k) })),
    openings: plan.openings.map((o) => ({ ...o, width: o.width * k })),
    rooms: plan.rooms.map((r) => {
      const polygon = r.polygon.map(s);
      return { ...r, polygon, areaM2: Math.round(polygonArea(polygon) * 10) / 10 };
    }),
    scale: { metersPerPixel: plan.scale.metersPerPixel ? plan.scale.metersPerPixel * k : null, source: "manual" },
    underlay: plan.underlay ? { ...plan.underlay, originM: s(plan.underlay.originM), metersPerPixel: plan.underlay.metersPerPixel * k } : null,
  };
}
