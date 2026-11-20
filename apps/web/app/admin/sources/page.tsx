"use client";
import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { api } from "@/lib/api";

export default function Sources() {
  const [rows, setRows] = useState<any[]>([]);
  const [domain, setDomain] = useState("");
  const [by, setBy] = useState("");
  const load = () => api("/api/sources").then(setRows);
  useEffect(() => {
    load();
  }, []);
  const save = (r: any, patch: any) =>
    api("/api/sources", {
      method: "POST",
      body: JSON.stringify({ domain: r.domain, adapter: r.adapter, rightsConfirmed: r.rights_confirmed, confirmedBy: r.confirmed_by ?? undefined, rateLimitMs: r.rate_limit_ms, notes: r.notes ?? undefined, ...patch }),
    }).then(load);
  return (
    <AdminShell title="Import sources">
      <div className="adm-card">
        <p>
          Listings are only imported from domains where you have confirmed the right to use the content (for example your own website or a partner
          agreement). The importer also obeys robots.txt and waits between requests (rate limit per domain).
        </p>
        <table className="adm-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Adapter</th>
              <th>Rights confirmed</th>
              <th>Confirmed by</th>
              <th>Delay between requests</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.domain}</td>
                <td>{r.adapter}</td>
                <td>
                  <input type="checkbox" checked={r.rights_confirmed} onChange={(e) => save(r, { rightsConfirmed: e.target.checked })} />
                </td>
                <td>{r.confirmed_by}</td>
                <td>
                  <input type="number" min={500} step={500} defaultValue={r.rate_limit_ms} onBlur={(e) => save(r, { rateLimitMs: Number(e.target.value) })} /> ms
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            api("/api/sources", { method: "POST", body: JSON.stringify({ domain, rightsConfirmed: true, confirmedBy: by || "admin" }) }).then(() => {
              setDomain("");
              load();
            });
          }}
        >
          <input placeholder="domain.com" value={domain} onChange={(e) => setDomain(e.target.value)} required />
          <input placeholder="Confirmed by (name)" value={by} onChange={(e) => setBy(e.target.value)} />
          <button className="adm-btn primary">Add & confirm rights</button>
        </form>
      </div>
    </AdminShell>
  );
}
