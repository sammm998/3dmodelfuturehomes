"use client";
import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { api } from "@/lib/api";

export default function Settings() {
  const [agencies, setAgencies] = useState<any[]>([]);
  const [providers, setProviders] = useState<any>(null);
  useEffect(() => {
    api("/api/agencies").then(setAgencies);
    api("/api/providers").then(setProviders).catch(() => setProviders({ error: "unavailable" }));
  }, []);
  return (
    <AdminShell title="Agency & providers">
      {agencies.map((a) => (
        <AgencyForm key={a.slug} a={a} />
      ))}
      <div className="adm-card">
        <h3>Reconstruction & AI providers</h3>
        {!providers && <p>Checking…</p>}
        {providers && (
          <>
            <p>
              Vision model: <b>{providers.vision}</b>
              {providers.vision === "heuristic" && " (offline fallback: set ANTHROPIC_API_KEY for Claude vision)"}
            </p>
            <p>
              Map: {providers.maps?.google3dTiles ? "Google Photorealistic 3D Tiles" : providers.maps?.mapbox ? "Mapbox satellite" : "stylised ground (no map key)"}
            </p>
            {Array.isArray(providers.reconstruction) ? (
              <table className="adm-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Layer</th>
                    <th>Output</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.reconstruction.map((r: any) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td>{r.layer}</td>
                      <td>
                        <span className={`pill prov-${r.provenance}`}>{r.provenance}</span>
                      </td>
                      <td>{r.available ? "available" : <span className="muted">{r.reason}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="err">{providers.reconstruction?.error}</p>
            )}
          </>
        )}
      </div>
    </AdminShell>
  );
}

function AgencyForm({ a }: { a: any }) {
  const [t, setT] = useState({ ...a.theme });
  const [wa, setWa] = useState(a.whatsapp ?? "");
  const [book, setBook] = useState(a.bookingUrl ?? "");
  const [saved, setSaved] = useState(false);
  return (
    <div className="adm-card form">
      <h3>{a.name} · white-label theme</h3>
      {(["primary", "accent", "background"] as const).map((k) => (
        <label key={k}>
          {k}
          <span className="color">
            <input type="color" value={t[k] ?? "#1a365d"} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
            <input value={t[k] ?? ""} onChange={(e) => setT({ ...t, [k]: e.target.value })} />
          </span>
        </label>
      ))}
      <label>
        Logo URL
        <input value={t.logoUrl ?? ""} onChange={(e) => setT({ ...t, logoUrl: e.target.value || null })} />
      </label>
      <label>
        Heading font
        <input value={t.fontHeading ?? ""} onChange={(e) => setT({ ...t, fontHeading: e.target.value })} />
      </label>
      <label>
        Body font
        <input value={t.fontBody ?? ""} onChange={(e) => setT({ ...t, fontBody: e.target.value })} />
      </label>
      <label>
        WhatsApp number
        <input value={wa} onChange={(e) => setWa(e.target.value)} />
      </label>
      <label>
        “Book a viewing” URL
        <input value={book} onChange={(e) => setBook(e.target.value)} />
      </label>
      <div className="swatch" style={{ background: t.primary, color: "#fff", fontFamily: t.fontHeading }}>
        <span style={{ background: t.accent }} /> {a.name}
      </div>
      <button
        className="adm-btn primary"
        onClick={() =>
          api(`/api/agencies/${a.slug}`, { method: "PATCH", body: JSON.stringify({ theme: t, whatsapp: wa, bookingUrl: book }) }).then(() => setSaved(true))
        }
      >
        Save theme
      </button>
      {saved && <span className="muted"> Saved</span>}
    </div>
  );
}
