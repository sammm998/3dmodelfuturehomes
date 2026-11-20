import { notFound } from "next/navigation";
import { ViewerLoader } from "@/components/viewer/ViewerLoader";
import { loadProperty, PUBLIC_WEB_URL } from "@/lib/page";

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const p = await loadProperty(slug);
  if (!p) notFound();
  return <ViewerLoader property={p} variant="embed" publicUrl={`${PUBLIC_WEB_URL}/p/${slug}`} />;
}
