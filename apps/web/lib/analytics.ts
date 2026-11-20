import type { AnalyticsEventType } from "@pv/shared";
import { API_URL } from "./api";

let sessionId: string | null = null;
const sid = () => {
  if (sessionId) return sessionId;
  try {
    sessionId = sessionStorage.getItem("pv_sid");
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem("pv_sid", sessionId);
    }
  } catch {
    sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return sessionId;
};

export function track(slug: string, type: AnalyticsEventType, meta?: Record<string, unknown>) {
  if (typeof window === "undefined" || !slug) return;
  const body = JSON.stringify({ sessionId: sid(), type, meta });
  const url = `${API_URL}/api/p/${encodeURIComponent(slug)}/events`;
  if (navigator.sendBeacon && type === "heartbeat") {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    return;
  }
  fetch(url, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
}
