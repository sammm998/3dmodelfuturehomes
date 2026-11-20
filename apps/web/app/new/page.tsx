"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { JobProgress } from "@/components/admin/JobProgress";
import { AdminShell } from "@/components/admin/AdminShell";
import { api } from "@/lib/api";

export default function NewProperty() {
  const [tab, setTab] = useState<"url" | "upload">("url");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fields, setFields] = useState({ title: "", location: "", sqm: "", bedrooms: "", bathrooms: "", price: "" });
  const [job, setJob] = useState<{ jobId: string; propertyId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);

  const submitUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      setJob(await api("/api/imports", { method: "POST", body: JSON.stringify({ url, agencySlug: "future-homes" }) }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const submitUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!files.length) return setError("Add at least one image, floor plan PDF or video.");
    setError(null);
    setBusy(true);
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => v && fd.append(k, v));
    fd.append("agencySlug", "future-homes");
    files.forEach((f) => fd.append("files", f, f.name));
    try {
      setJob(await api("/api/uploads", { method: "POST", body: fd }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const onDone = useCallback((j: any) => setFinished(j.status), []);

  return (
    <AdminShell title="New property">
      {!job ? (
        <div className="adm-card new">
          <div className="tabs">
            <button className={tab === "url" ? "on" : ""} onClick={() => setTab("url")}>
              Import from URL
            </button>
            <button className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
              Upload images, plans & video
            </button>
          </div>
          {tab === "url" ? (
            <form onSubmit={submitUrl}>
              <label>Listing URL</label>
              <input type="url" required placeholder="https://futurehomesinternational.com/property/…" value={url} onChange={(e) => setUrl(e.target.value)} />
              <p className="hint">
                Only domains with confirmed content rights can be imported (Admin → Sources). robots.txt and rate limits are respected.
              </p>
              <button className="adm-btn primary" disabled={busy}>
                {busy ? "Starting…" : "Import & build 3D"}
              </button>
            </form>
          ) : (
            <form onSubmit={submitUpload}>
              <div
                className="drop"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]);
                }}
              >
                <p>Drag & drop photos, floor plans (image/PDF) and walkthrough videos (mp4, phone recordings)</p>
                <input type="file" multiple accept="image/*,application/pdf,video/*" onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])} />
                {files.length > 0 && (
                  <ul>
                    {files.map((f, i) => (
                      <li key={i}>
                        {f.name} <small>{(f.size / 1e6).toFixed(1)} MB</small>
                        <button type="button" onClick={() => setFiles(files.filter((_, k) => k !== i))}>
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="hint">Tip: name floor plan files with “plan” (e.g. ground-floor-plan.png) to help classification.</p>
              </div>
              <div className="grid2">
                {(
                  [
                    ["title", "Title"],
                    ["location", "Location"],
                    ["price", "Price (EUR)"],
                    ["sqm", "Size (m²)"],
                    ["bedrooms", "Bedrooms"],
                    ["bathrooms", "Bathrooms"],
                  ] as const
                ).map(([k, l]) => (
                  <label key={k}>
                    {l}
                    <input value={fields[k]} onChange={(e) => setFields({ ...fields, [k]: e.target.value })} />
                  </label>
                ))}
              </div>
              <button className="adm-btn primary" disabled={busy}>
                {busy ? "Uploading…" : "Upload & build 3D"}
              </button>
            </form>
          )}
          {error && <p className="err">{error}</p>}
        </div>
      ) : (
        <>
          <JobProgress jobId={job.jobId} onDone={onDone} />
          {finished && (
            <div className="adm-actions">
              <Link className="adm-btn primary" href={`/admin/properties/${job.propertyId}`}>
                Review & publish
              </Link>
            </div>
          )}
        </>
      )}
    </AdminShell>
  );
}
