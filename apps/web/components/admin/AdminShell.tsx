"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  ["/admin", "Properties"],
  ["/new", "New property"],
  ["/admin/sources", "Sources"],
  ["/admin/settings", "Agency & providers"],
] as const;

export function AdminShell({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  const path = usePathname();
  const [token, setToken] = useState<string>("");
  const [needLogin, setNeedLogin] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setToken(localStorage.getItem("pv_admin_token") ?? "");
    const onUnauth = () => setNeedLogin(true);
    window.addEventListener("pv-unauthorized", onUnauth);
    return () => window.removeEventListener("pv-unauthorized", onUnauth);
  }, []);
  return (
    <div className="adm">
      <aside className="adm-nav">
        <Link href="/" className="adm-logo">
          Property<span>Verse</span>
        </Link>
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} className={path === href ? "on" : ""}>
            {label}
          </Link>
        ))}
        <details className="adm-token">
          <summary>Admin token</summary>
          <input
            type="password"
            placeholder="ADMIN_TOKEN (if set)"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              localStorage.setItem("pv_admin_token", e.target.value);
            }}
          />
        </details>
      </aside>
      {needLogin && (
        <div className="adm-login">
          <form
            className="adm-card"
            onSubmit={(e) => {
              e.preventDefault();
              localStorage.setItem("pv_admin_token", draft.trim());
              location.reload();
            }}
          >
            <h2>Logga in i admin</h2>
            <p className="muted">
              Klistra in din admin-token. Du hittar den i Railway: tjänsten <b>api</b> → <b>Variables</b> → <code>ADMIN_TOKEN</code>.
            </p>
            <input type="password" autoFocus placeholder="Admin-token" value={draft} onChange={(e) => setDraft(e.target.value)} required />
            <button className="adm-btn primary">Logga in</button>
          </form>
        </div>
      )}
      <main className="adm-main">
        <div className="adm-head">
          <h1>{title}</h1>
          <div className="adm-head-actions">{actions}</div>
        </div>
        {children}
      </main>
    </div>
  );
}
