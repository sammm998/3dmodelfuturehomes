"use client";
import dynamic from "next/dynamic";
import type { Property } from "@/lib/types";

const ViewerApp = dynamic(() => import("./ViewerApp"), {
  ssr: false,
  loading: () => (
    <div className="pv-loading">
      <div className="pv-spinner" />
      <p>Loading 3D experience…</p>
    </div>
  ),
});

export function ViewerLoader(props: { property: Property; variant?: "full" | "embed" | "booth"; publicUrl: string }) {
  return <ViewerApp {...props} />;
}
