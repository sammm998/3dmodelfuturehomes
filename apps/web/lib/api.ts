export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
/** server-side (inside docker network) base URL */
export const INTERNAL_API_URL = process.env.INTERNAL_API_URL || API_URL;

export const fileUrl = (key: string | null | undefined) =>
  key ? (key.startsWith("http") ? key : `${API_URL}/files/${key.split("/").map(encodeURIComponent).join("/")}`) : null;

function adminHeaders(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const t = window.localStorage.getItem("pv_admin_token");
  return t ? { authorization: `Bearer ${t}` } : {};
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body && !isForm ? { "content-type": "application/json" } : {}),
      ...adminHeaders(),
      ...(init.headers as Record<string, string>),
    },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event("pv-unauthorized"));
    throw Object.assign(new Error("Logga in med admin-token för att fortsätta."), { status: 401, data });
  }
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data as T;
}

export async function serverGet<T = any>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${INTERNAL_API_URL}${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const money = (price: number | null | undefined, currency: string | null | undefined, fallback?: string | null) =>
  price
    ? new Intl.NumberFormat("en-GB", { style: "currency", currency: currency || "EUR", maximumFractionDigits: 0 }).format(price)
    : fallback || "Price on request";
