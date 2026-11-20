"use client";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";

interface Step {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  message: string | null;
}
interface Job {
  id: string;
  status: string;
  steps: Step[];
  error: string | null;
}

const ICON: Record<Step["status"], string> = { pending: "○", running: "◌", done: "✓", skipped: "–", failed: "✕" };

/** Live step-by-step job status over Server-Sent Events. */
export function JobProgress({ jobId, onDone }: { jobId: string; onDone?: (job: Job) => void }) {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/jobs/${jobId}/events`);
    es.onmessage = (e) => {
      const j = JSON.parse(e.data) as Job;
      setJob(j);
      if (j.status === "done" || j.status === "failed") {
        es.close();
        onDone?.(j);
      }
    };
    es.onerror = () => {
      // fall back to polling if SSE is blocked by a proxy
      es.close();
      const id = setInterval(async () => {
        const r = await fetch(`${API_URL}/api/jobs/${jobId}`).then((x) => x.json());
        setJob(r);
        if (r.status === "done" || r.status === "failed") {
          clearInterval(id);
          onDone?.(r);
        }
      }, 2000);
    };
    return () => es.close();
  }, [jobId, onDone]);

  if (!job) return <div className="adm-card">Connecting…</div>;
  const visible = job.steps.filter((s) => !(s.status === "skipped" && !s.message));
  const done = job.steps.filter((s) => ["done", "skipped"].includes(s.status)).length;
  return (
    <div className="adm-card job">
      <div className="job-head">
        <strong>{job.status === "done" ? "Ready" : job.status === "failed" ? "Failed" : "Building your 3D property…"}</strong>
        <span>{Math.round((done / job.steps.length) * 100)}%</span>
      </div>
      <div className="job-bar">
        <div style={{ width: `${(done / job.steps.length) * 100}%` }} />
      </div>
      <ol className="job-steps">
        {visible.map((s) => (
          <li key={s.key} className={`st-${s.status}`}>
            <span className="ic">{ICON[s.status]}</span>
            <span className="lb">{s.label}</span>
            {s.message && <span className="msg">{s.message}</span>}
          </li>
        ))}
      </ol>
      {job.error && <p className="err">{job.error}</p>}
    </div>
  );
}
