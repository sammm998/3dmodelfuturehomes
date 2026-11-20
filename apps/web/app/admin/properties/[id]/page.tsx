"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import type { PlanSpec } from "@pv/shared";
import { AdminShell } from "@/components/admin/AdminShell";
import { JobProgress } from "@/components/admin/JobProgress";
import { PlanEditor } from "@/components/admin/PlanEditor";
import { api, money } from "@/lib/api";
import type { Property } from "@/lib/types";

const PlanPreview3D = dynamic(() => import("@/components/admin/PlanPreview3D"), { ssr: false });

type Tab = "overview" | "floors" | "media" | "hotspots" | "analytics";

export default function PropertyAdmin({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [p, setP] = useState<Property | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api<Property>(`/api/properties/${id}`).then(setP).catch((e) => setErr(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);
  const running = p?.jobs?.find((j) => j.status === "running" || j.status === "queued");

  if (!p) return <AdminShell title="Property">{err ? <p className="err">{err}</p> : <p>Loading…</p>}</AdminShell>;
  const token = typeof window !== "undefined" ? localStorage.getItem("pv_admin_token") ?? "" : "";
  const published = p.status === "published";

  return (
    <AdminShell
      title={p.title}
      actions={
        <>
          <a className="adm-btn" href={`/p/${p.slug}?preview=${token}`} target="_blank">
            Open viewer
          </a>
          <a className="adm-btn" href={`/booth/${p.slug}?preview=${token}`} target="_blank">
            Booth mode
          </a>
          <button className="adm-btn" onClick={() => api(`/api/properties/${id}/reprocess`, { method: "POST", body: JSON.stringify({ mode: p.sourceUrl ? "refetch" : "reprocess" }) }).then(load)}>
            Re-run pipeline
          </button>
          <button
            className={`adm-btn ${published ? "" : "primary"}`}
            onClick={() => api(`/api/properties/${id}/${published ? "unpublish" : "publish"}`, { method: "POST" }).then(load)}
          >
            {published ? "Unpublish" : "Publish"}
          </button>
        </>
      }
    >
      <div className="adm-sub">
        <span className={`pill st-${p.status}`}>{p.status}</span>
        <span>{p.location}</span>
        <span>{money(p.price, p.currency, p.priceText)}</span>
        {p.sourceUrl && (
          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
            source ↗
          </a>
        )}
      </div>
      {running && <JobProgress jobId={running.id} onDone={() => load()} />}
      <div className="tabs">
        {(["overview", "floors", "media", "hotspots", "analytics"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview p={p} onSaved={load} />}
      {tab === "floors" && <Floors p={p} onSaved={load} />}
      {tab === "media" && <Media p={p} />}
      {tab === "hotspots" && <Hotspots p={p} onSaved={load} />}
      {tab === "analytics" && <Analytics id={p.id} />}
    </AdminShell>
  );
}

function Overview({ p, onSaved }: { p: Property; onSaved: () => void }) {
  const [f, setF] = useState({
    title: p.title,
    price: p.price ?? "",
    priceText: p.priceText ?? "",
    location: p.location ?? "",
    lat: p.lat ?? "",
    lng: p.lng ?? "",
    bedrooms: p.bedrooms ?? "",
    bathrooms: p.bathrooms ?? "",
    sqm: p.sqm ?? "",
    availability: p.availability ?? "Available",
    description: p.description ?? "",
  });
  const [saved, setSaved] = useState(false);
  const num = (v: any) => (v === "" || v == null ? null : Number(v));
  const save = async () => {
    await api(`/api/properties/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...f,
        price: num(f.price),
        lat: num(f.lat),
        lng: num(f.lng),
        bedrooms: num(f.bedrooms),
        bathrooms: num(f.bathrooms),
        sqm: num(f.sqm),
      }),
    });
    setSaved(true);
    onSaved();
  };
  const jobs = p.jobs ?? [];
  return (
    <div className="adm-grid">
      <div className="adm-card form">
        {(["title", "location", "price", "priceText", "availability", "bedrooms", "bathrooms", "sqm", "lat", "lng"] as const).map((k) => (
          <label key={k}>
            {k}
            <input value={(f as any)[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        <label className="wide">
          description
          <textarea rows={6} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <button className="adm-btn primary" onClick={save}>
          Save
        </button>
        {saved && <span className="muted"> Saved</span>}
      </div>
      <div className="adm-card">
        <h3>3D result</h3>
        <ul className="kv">
          {p.buildings[0]?.floors.map((fl) => (
            <li key={fl.id}>
              <span>{fl.name}</span>
              <span className={`pill plan-${fl.planStatus}`}>{fl.planStatus.replace("_", " ")}</span>
              <span>{fl.plan ? `${fl.plan.rooms.length} rooms · ${Math.round(fl.plan.confidence * 100)}%` : "no plan"}</span>
            </li>
          ))}
          <li>
            <span>Building</span>
            <span>{p.buildings[0]?.floorsCount ?? 0} storeys</span>
          </li>
          {[...p.artifacts, ...(p.buildings[0]?.artifacts ?? [])].map((a) => (
            <li key={a.id}>
              <span>{a.kind}</span>
              <span className={`pill prov-${a.provenance}`}>{a.provenance}</span>
              <a href={a.url} target="_blank">
                {a.provider}
              </a>
            </li>
          ))}
          <li>
            <span>Panoramas</span>
            <span>{p.buildings[0]?.floors.flatMap((f) => f.rooms).filter((r) => r.artifacts.some((a) => a.kind === "panorama")).length ?? 0}</span>
          </li>
        </ul>
        <h3>Recent jobs</h3>
        {jobs.map((j) => (
          <details key={j.id}>
            <summary>
              {j.type} · <span className={`pill st-${j.status}`}>{j.status}</span> · {new Date(j.created_at).toLocaleString()}
            </summary>
            <ul className="job-steps small">
              {j.steps
                .filter((s: any) => s.message || s.status !== "skipped")
                .map((s: any) => (
                  <li key={s.key} className={`st-${s.status}`}>
                    <span className="lb">{s.label}</span>
                    <span className="msg">{s.message}</span>
                  </li>
                ))}
            </ul>
            {j.error && <p className="err">{j.error}</p>}
          </details>
        ))}
      </div>
    </div>
  );
}

function Floors({ p, onSaved }: { p: Property; onSaved: () => void }) {
  const b = p.buildings[0];
  const [idx, setIdx] = useState(0);
  const floor = b?.floors[idx];
  const [draft, setDraft] = useState<PlanSpec | null>(floor?.plan ?? null);
  const [status, setStatus] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  useEffect(() => setDraft(b?.floors[idx]?.plan ?? null), [idx, b]);
  if (!b || !floor) return <p className="muted">No floors yet.</p>;
  const save = async () => {
    setStatus("Saving…");
    try {
      const r = await api(`/api/floors/${floor.id}/plan`, { method: "PUT", body: JSON.stringify({ plan: draft }) });
      setJob(r.jobId);
      setStatus("Saved. Rebuilding 3D…");
    } catch (e: any) {
      setStatus(`Error: ${e.message}`);
    }
  };
  return (
    <div>
      <div className="floor-tabs">
        {b.floors.map((f, i) => (
          <button key={f.id} className={i === idx ? "on" : ""} onClick={() => setIdx(i)}>
            {f.name} <span className={`pill plan-${f.planStatus}`}>{f.planStatus.replace("_", " ")}</span>
          </button>
        ))}
      </div>
      {floor.plan?.provenance === "illustrative" && (
        <p className="note">This layout is illustrative (generated without a floor plan). Upload a floor plan or correct it here.</p>
      )}
      {draft && (
        <div className="floor-edit">
          <PlanEditor plan={floor.plan!} onChange={setDraft} />
          <div className="floor-preview">
            <PlanPreview3D plan={draft} building={b} />
          </div>
        </div>
      )}
      <div className="adm-actions">
        <button className="adm-btn primary" onClick={save}>
          Save & rebuild 3D
        </button>
        <button className="adm-btn" onClick={() => setDraft(floor.plan)}>
          Discard changes
        </button>
        {status && <span className="muted">{status}</span>}
      </div>
      {job && (
        <JobProgress
          jobId={job}
          onDone={() => {
            setStatus("3D rebuilt");
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function Media({ p }: { p: Property }) {
  const rooms = new Map(p.buildings[0]?.floors.flatMap((f) => f.rooms.map((r) => [r.id, `${r.name} (${f.name})`] as const)) ?? []);
  return (
    <div className="media-grid">
      {p.media
        .filter((m) => m.kind !== "video" && m.kind !== "pdf")
        .map((m) => (
          <figure key={m.id} className={`media c-${m.classification?.class ?? "none"}`}>
            <a href={m.url} target="_blank">
              <img src={m.thumbUrl} alt="" loading="lazy" />
            </a>
            <figcaption>
              <span className="pill">{m.classification?.class ?? "unclassified"}</span>
              {m.classification?.roomType && <span>{m.classification.roomType}</span>}
              {m.classification?.amenity && <span>{m.classification.amenity}</span>}
              {m.confidence != null && <span className={m.confidence < 0.5 ? "low" : ""}>{Math.round(m.confidence * 100)}%</span>}
              {m.roomId && <span className="room">→ {rooms.get(m.roomId)}</span>}
            </figcaption>
          </figure>
        ))}
      {p.media
        .filter((m) => m.kind === "video" || m.kind === "pdf")
        .map((m) => (
          <figure key={m.id} className="media file">
            <a href={m.url} target="_blank">
              {m.kind.toUpperCase()}
            </a>
            <figcaption>{m.sourceUrl?.split("/").pop()}</figcaption>
          </figure>
        ))}
    </div>
  );
}

function Hotspots({ p, onSaved }: { p: Property; onSaved: () => void }) {
  return (
    <div className="adm-card">
      <table className="adm-table">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Title</th>
            <th>Text</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.hotspots.map((h) => (
            <HotspotRow key={h.id} h={h} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
      <p className="muted">Edited hotspots are kept when the 3D is rebuilt.</p>
    </div>
  );
}

function HotspotRow({ h, onSaved }: { h: Property["hotspots"][number]; onSaved: () => void }) {
  const [t, setT] = useState(h.title);
  const [b, setB] = useState(h.body ?? "");
  return (
    <tr>
      <td>
        <span className="pill">{h.kind}</span>
      </td>
      <td>
        <input value={t} onChange={(e) => setT(e.target.value)} />
      </td>
      <td>
        <input value={b} onChange={(e) => setB(e.target.value)} />
      </td>
      <td>
        <button className="adm-btn" onClick={() => api(`/api/hotspots/${h.id}`, { method: "PATCH", body: JSON.stringify({ title: t, body: b }) }).then(onSaved)}>
          Save
        </button>
      </td>
    </tr>
  );
}

function Analytics({ id }: { id: string }) {
  const [a, setA] = useState<any>(null);
  useEffect(() => {
    api(`/api/properties/${id}/analytics`).then(setA);
  }, [id]);
  if (!a) return <p>Loading…</p>;
  const max = Math.max(1, ...a.daily.map((d: any) => d.visits));
  const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
  return (
    <div className="adm-grid">
      <div className="adm-card stats">
        <div>
          <b>{a.visits}</b>
          <span>visits</span>
        </div>
        <div>
          <b>{fmt(a.avg_seconds)}</b>
          <span>avg. time in 3D</span>
        </div>
        <div>
          <b>{a.whatsapp}</b>
          <span>WhatsApp clicks</span>
        </div>
        <div>
          <b>{a.booking}</b>
          <span>viewing requests</span>
        </div>
        <div>
          <b>{a.shares}</b>
          <span>shares / embeds</span>
        </div>
        <div>
          <b>{a.ar}</b>
          <span>AR sessions</span>
        </div>
      </div>
      <div className="adm-card">
        <h3>Last 30 days</h3>
        <div className="bars">
          {a.daily.map((d: any) => (
            <div key={d.day} title={`${d.day}: ${d.visits} visits, ${d.leads} leads`}>
              <i style={{ height: `${(d.visits / max) * 100}%` }} />
              <small>{d.day.slice(5)}</small>
            </div>
          ))}
          {!a.daily.length && <p className="muted">No visits yet.</p>}
        </div>
        <h3>Most used views</h3>
        <ul className="kv">
          {a.modes.map((m: any) => (
            <li key={m.mode}>
              <span>{m.mode}</span>
              <span>{m.n}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export const _unused = Link;
