import { serverGet } from "./api";
import type { Property } from "./types";

export const PUBLIC_WEB_URL = process.env.PUBLIC_WEB_URL || process.env.NEXT_PUBLIC_WEB_URL || "http://localhost:3000";

export async function loadProperty(slug: string, preview?: string): Promise<Property | null> {
  return serverGet<Property>(`/api/p/${encodeURIComponent(slug)}${preview ? `?preview=${encodeURIComponent(preview)}` : ""}`);
}
