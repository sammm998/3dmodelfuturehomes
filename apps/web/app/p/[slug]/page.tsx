import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ViewerLoader } from "@/components/viewer/ViewerLoader";
import { loadProperty, PUBLIC_WEB_URL } from "@/lib/page";

type P = { params: Promise<{ slug: string }>; searchParams: Promise<{ preview?: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { slug } = await params;
  const p = await loadProperty(slug);
  const img = p?.media.find((m) => m.classification?.class === "exterior")?.url;
  return {
    title: p ? `${p.title} · 3D tour` : "3D tour",
    description: p?.description?.slice(0, 160) ?? undefined,
    openGraph: p ? { title: `${p.title} · 3D tour`, images: img ? [img] : [] } : undefined,
  };
}

export default async function Page({ params, searchParams }: P) {
  const { slug } = await params;
  const { preview } = await searchParams;
  const p = await loadProperty(slug, preview);
  if (!p) notFound();
  return <ViewerLoader property={p} variant="full" publicUrl={`${PUBLIC_WEB_URL}/p/${slug}`} />;
}
