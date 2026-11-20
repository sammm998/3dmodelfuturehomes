import Link from "next/link";
import { money, serverGet } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function Home() {
  const items = (await serverGet<any[]>("/api/published")) ?? [];
  return (
    <div className="home">
      <header className="home-hero">
        <div>
          <p className="eyebrow">PropertyVerse</p>
          <h1>Walk through the property before you visit.</h1>
          <p>Interactive 3D showcases built from listings, floor plans, photos and video: exterior, dollhouse, floor plan, walkthrough and 360°.</p>
          <div className="home-cta">
            <Link href="/new" className="pv-btn pv-btn-primary">
              Import a listing
            </Link>
            <Link href="/admin" className="pv-btn">
              Admin
            </Link>
          </div>
        </div>
      </header>
      <section className="home-grid">
        {items.map((p) => (
          <Link key={p.slug} href={`/p/${p.slug}`} className="home-card">
            <div className="thumb" style={p.thumbUrl ? { backgroundImage: `url(${p.thumbUrl})` } : undefined}>
              {!p.thumbUrl && <span>3D</span>}
            </div>
            <div className="meta">
              <h3>{p.title}</h3>
              <p>{p.location}</p>
              <strong>{money(p.price, p.currency, p.priceText)}</strong>
            </div>
          </Link>
        ))}
        {!items.length && <p className="muted">No published properties yet. Run the seed or import a listing.</p>}
      </section>
    </div>
  );
}
