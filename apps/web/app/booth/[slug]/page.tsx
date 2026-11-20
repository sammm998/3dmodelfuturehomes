import { notFound } from "next/navigation";
import { ViewerLoader } from "@/components/viewer/ViewerLoader";
import { loadProperty, PUBLIC_WEB_URL } from "@/lib/page";

/** Exhibition booth mode: fullscreen, looping camera tour, QR code to the listing. */
export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { slug } = await params;
  const { preview } = await searchParams;
  const p = await loadProperty(slug, preview);
  if (!p) notFound();
  return <ViewerLoader property={p} variant="booth" publicUrl={`${PUBLIC_WEB_URL}/p/${slug}`} />;
}
