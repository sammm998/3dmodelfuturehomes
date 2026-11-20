"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AdminShell } from "@/components/admin/AdminShell";
import { api, money } from "@/lib/api";

export default function AdminList() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api("/api/properties").then(setRows).catch((e) => setErr(e.message));
  }, []);
  return (
    <AdminShell
      title="Properties"
      actions={
        <Link className="adm-btn primary" href="/new">
          + New property
        </Link>
      }
    >
      {err && <p className="err">{err} (set the admin token in the sidebar if the API requires one)</p>}
      <table className="adm-table">
        <thead>
          <tr>
            <th />
            <th>Property</th>
            <th>Status</th>
            <th>Price</th>
            <th>Visits</th>
            <th>Leads</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows?.map((p) => (
            <tr key={p.id}>
              <td>{p.thumbUrl ? <img className="thumb" src={p.thumbUrl} alt="" /> : <div className="thumb ph">3D</div>}</td>
              <td>
                <Link href={`/admin/properties/${p.id}`}>
                  <strong>{p.title}</strong>
                </Link>
                <div className="muted">{p.location ?? p.sourceUrl ?? ""}</div>
              </td>
              <td>
                <span className={`pill st-${p.status}`}>{p.status}</span>
                {p.lastJob?.status === "running" && <span className="pill st-processing">building</span>}
              </td>
              <td>{money(p.price, p.currency, p.priceText)}</td>
              <td>{p.visits}</td>
              <td>{p.leads}</td>
              <td className="row-actions">
                <a href={`/p/${p.slug}?preview=${typeof window !== "undefined" ? localStorage.getItem("pv_admin_token") ?? "" : ""}`} target="_blank">
                  Viewer
                </a>
                <a href={`/booth/${p.slug}`} target="_blank">
                  Booth
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows && !rows.length && <p className="muted">No properties yet.</p>}
    </AdminShell>
  );
}
