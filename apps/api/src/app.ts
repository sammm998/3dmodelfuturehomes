import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AgencyTheme,
  AnalyticsEventType,
  PlanSpec,
  PIPELINE_STEPS,
} from "@pv/shared";
import {
  connection,
  createJob,
  env,
  getObjectStream,
  initialSteps,
  jobChannel,
  one,
  pipelineQueue,
  propertyTree,
  q,
  runPy,
  storeMedia,
  syncRooms,
  uniqueSlug,
} from "@pv/server";

const ImportBody = z.object({ url: z.string().url(), agencySlug: z.string().optional() });

export async function buildApp() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 5 * 1024 * 1024 });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024, files: 60 } });

  // ---- auth for admin routes (open when ADMIN_TOKEN is unset, e.g. local dev) ----
  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!env.adminToken) return;
    const h = req.headers.authorization ?? "";
    if (h !== `Bearer ${env.adminToken}`) return reply.code(401).send({ error: "unauthorized" });
  };

  app.get("/health", async () => ({ ok: true }));

  // ---- files: stream objects from S3 (range requests for video / large splats) ----
  app.get("/files/*", async (req, reply) => {
    const key = decodeURIComponent((req.params as any)["*"]);
    if (!key.startsWith("properties/") && !key.startsWith("agencies/") && !key.startsWith("library/")) return reply.code(404).send();
    try {
      const o = await getObjectStream(key, req.headers.range);
      reply.header("cache-control", "public, max-age=3600");
      reply.header("accept-ranges", "bytes");
      if (o.contentType) reply.type(o.contentType);
      if (o.contentLength != null) reply.header("content-length", o.contentLength);
      if (o.contentRange) reply.code(206).header("content-range", o.contentRange);
      return reply.send(o.body);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  // ---- imports ----
  app.post("/api/imports", { preHandler: admin }, async (req, reply) => {
    const body = ImportBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid url" });
    const url = body.data.url;
    const host = new URL(url).hostname.replace(/^www\./, "");
    const src = await one("select * from scrape_sources where domain=$1 or domain=$2", [host, `www.${host}`]);
    if (!src?.rights_confirmed)
      return reply.code(403).send({
        error: "domain_not_allowed",
        message: `Import from ${host} is disabled until an admin confirms that we have the right to use its content (Admin → Sources).`,
        domain: host,
      });
    const agency = body.data.agencySlug ? await one("select id from agencies where slug=$1", [body.data.agencySlug]) : null;
    const slug = await uniqueSlug(url.split("/").filter(Boolean).pop() ?? host);
    const p = await one<{ id: string }>(
      "insert into properties(agency_id, slug, status, source_url, title) values ($1,$2,'processing',$3,$4) returning id",
      [agency?.id ?? null, slug, url, "Importing…"],
    );
    const job = await createJob(p!.id, "import", { url }, initialSteps());
    await pipelineQueue().add("import", { jobId: job!.id, propertyId: p!.id, mode: "url", url }, { removeOnComplete: 100, removeOnFail: 200 });
    return { propertyId: p!.id, jobId: job!.id, slug };
  });

  app.post("/api/uploads", { preHandler: admin }, async (req, reply) => {
    const fields: Record<string, string> = {};
    const files: { buf: Buffer; mime: string; name: string }[] = [];
    for await (const part of req.parts()) {
      if (part.type === "file") files.push({ buf: await part.toBuffer(), mime: part.mimetype, name: part.filename });
      else fields[part.fieldname] = String(part.value ?? "");
    }
    if (!files.length) return reply.code(400).send({ error: "no files" });
    const agency = fields.agencySlug ? await one("select id from agencies where slug=$1", [fields.agencySlug]) : null;
    const title = fields.title?.trim() || "Uploaded property";
    const num = (k: string) => (fields[k] ? Number(fields[k]) || null : null);
    const p = await one<{ id: string }>(
      `insert into properties(agency_id, slug, status, title, location, sqm, bedrooms, bathrooms, price, currency, description)
       values ($1,$2,'processing',$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [agency?.id ?? null, await uniqueSlug(title), title, fields.location || null, num("sqm"), num("bedrooms"), num("bathrooms"), num("price"), fields.currency || "EUR", fields.description || null],
    );
    let stored = 0;
    for (const [i, f] of files.entries()) {
      const isPlan = /plan|plano|layout/i.test(f.name) || fields[`kind_${i}`] === "floorplan";
      const kind = f.mime === "application/pdf" ? "pdf" : f.mime.startsWith("video/") ? "video" : isPlan ? "floorplan" : "image";
      if (await storeMedia(p!.id, f.buf, f.mime, { kind, alt: f.name, sort: i })) stored++;
    }
    const job = await createJob(p!.id, "upload", { files: stored }, initialSteps(["fetch"]));
    await pipelineQueue().add("upload", { jobId: job!.id, propertyId: p!.id, mode: "upload" }, { removeOnComplete: 100, removeOnFail: 200 });
    return { propertyId: p!.id, jobId: job!.id, stored };
  });

  app.post("/api/properties/:id/media", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    let stored = 0;
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      const buf = await part.toBuffer();
      const kind = part.mimetype === "application/pdf" ? "pdf" : part.mimetype.startsWith("video/") ? "video" : /plan/i.test(part.filename) ? "floorplan" : "image";
      if (await storeMedia(id, buf, part.mimetype, { kind, alt: part.filename })) stored++;
    }
    return { stored };
  });

  app.post("/api/properties/:id/reprocess", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    const { mode = "reprocess" } = (req.body as any) ?? {};
    const p = await one("select source_url from properties where id=$1", [id]);
    const m = mode === "rebake" ? "rebake" : p?.source_url && mode === "refetch" ? "url" : "reprocess";
    const job = await createJob(id, m, {}, initialSteps(m === "url" ? [] : ["fetch"]));
    await pipelineQueue().add(m, { jobId: job!.id, propertyId: id, mode: m, url: p?.source_url }, { removeOnComplete: 100 });
    return { jobId: job!.id };
  });

  // ---- jobs ----
  app.get("/api/jobs/:id", async (req, reply) => {
    const job = await one("select id, property_id, type, status, steps, error, created_at, finished_at from jobs where id=$1", [(req.params as any).id]);
    return job ?? reply.code(404).send({ error: "not found" });
  });

  app.get("/api/jobs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await one("select id, property_id, status, steps, error from jobs where id=$1", [id]);
    if (!job) return reply.code(404).send();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": req.headers.origin ?? "*",
    });
    const send = (data: unknown) => reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    send(job);
    if (job.status === "done" || job.status === "failed") return reply.raw.end();
    const sub = connection();
    await sub.subscribe(jobChannel(id));
    sub.on("message", (_c, msg) => {
      reply.raw.write(`data: ${msg}\n\n`);
      const j = JSON.parse(msg);
      if (j.status === "done" || j.status === "failed") cleanup();
    });
    const ping = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    const cleanup = () => {
      clearInterval(ping);
      sub.quit().catch(() => {});
      reply.raw.end();
    };
    req.raw.on("close", cleanup);
  });

  // ---- properties (admin) ----
  app.get("/api/properties", { preHandler: admin }, async () => {
    return q(`
      select p.id, p.slug, p.title, p.status, p.location, p.price, p.currency, p.price_text as "priceText", p.created_at as "createdAt",
        p.updated_at as "updatedAt", p.published_at as "publishedAt", p.source_url as "sourceUrl", a.name as agency,
        (select s3_key from media_assets m where m.property_id=p.id and m.classification->>'class'='exterior' order by sort limit 1) as cover_key,
        (select thumb_key from media_assets m where m.property_id=p.id and m.kind='image' order by sort limit 1) as thumb_key,
        (select count(distinct session_id)::int from analytics_events e where e.property_id=p.id and e.type='view') as visits,
        (select count(*)::int from analytics_events e where e.property_id=p.id and e.type like 'lead_%') as leads,
        (select json_build_object('id', j.id, 'status', j.status) from jobs j where j.property_id=p.id order by created_at desc limit 1) as "lastJob"
      from properties p left join agencies a on a.id=p.agency_id order by p.created_at desc`).then((rows) =>
      rows.map(({ cover_key, thumb_key, ...r }) => ({
        ...r,
        thumbUrl: thumb_key || cover_key ? `${env.publicApiUrl}/files/${thumb_key ?? cover_key}` : null,
      })),
    );
  });

  app.get("/api/properties/:id", { preHandler: admin }, async (req, reply) => {
    const t = await propertyTree({ id: (req.params as any).id });
    if (!t) return reply.code(404).send({ error: "not found" });
    const jobs = await q("select id, type, status, steps, error, created_at, finished_at from jobs where property_id=$1 order by created_at desc limit 5", [t.id]);
    return { ...t, jobs };
  });

  const PatchProperty = z.object({
    title: z.string().min(1).optional(),
    price: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    priceText: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    bedrooms: z.number().int().nullable().optional(),
    bathrooms: z.number().int().nullable().optional(),
    sqm: z.number().nullable().optional(),
    availability: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    agencySlug: z.string().nullable().optional(),
  });
  app.patch("/api/properties/:id", { preHandler: admin }, async (req, reply) => {
    const b = PatchProperty.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues });
    const map: Record<string, string> = { priceText: "price_text" };
    const sets: string[] = [];
    const vals: unknown[] = [(req.params as any).id];
    for (const [k, v] of Object.entries(b.data)) {
      if (k === "agencySlug") {
        vals.push(v);
        sets.push(`agency_id = (select id from agencies where slug=$${vals.length})`);
      } else {
        vals.push(v);
        sets.push(`${map[k] ?? k} = $${vals.length}`);
      }
    }
    if (sets.length) await q(`update properties set ${sets.join(", ")}, updated_at=now() where id=$1`, vals);
    return propertyTree({ id: (req.params as any).id });
  });

  app.post("/api/properties/:id/publish", { preHandler: admin }, async (req) => {
    await q("update properties set status='published', published_at=coalesce(published_at, now()), updated_at=now() where id=$1", [(req.params as any).id]);
    return { ok: true };
  });
  app.post("/api/properties/:id/unpublish", { preHandler: admin }, async (req) => {
    await q("update properties set status='unpublished', updated_at=now() where id=$1", [(req.params as any).id]);
    return { ok: true };
  });
  app.delete("/api/properties/:id", { preHandler: admin }, async (req) => {
    await q("delete from properties where id=$1", [(req.params as any).id]);
    return { ok: true };
  });

  // edit a floor plan in the 2D editor → save + rebuild 3D
  app.put("/api/floors/:id/plan", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PlanSpec.safeParse((req.body as any)?.plan);
    if (!parsed.success) return reply.code(400).send({ error: "invalid plan", issues: parsed.error.issues.slice(0, 5) });
    const f = await one("select f.id, b.property_id from floors f join buildings b on b.id=f.building_id where f.id=$1", [id]);
    if (!f) return reply.code(404).send();
    const plan = { ...parsed.data, provenance: parsed.data.provenance === "illustrative" ? "illustrative" : "measured", confidence: 1 };
    await q("update floors set plan_spec=$2, plan_status='edited' where id=$1", [id, JSON.stringify(plan)]);
    await syncRooms(id, plan as any);
    const job = await createJob(f.property_id, "rebake", {}, initialSteps(PIPELINE_STEPS.map((s) => s.key).filter((k) => !["bake", "hotspots"].includes(k))));
    await pipelineQueue().add("rebake", { jobId: job!.id, propertyId: f.property_id, mode: "rebake" }, { removeOnComplete: 100 });
    return { ok: true, jobId: job!.id };
  });

  app.patch("/api/hotspots/:id", { preHandler: admin }, async (req) => {
    const b = z.object({ title: z.string().optional(), body: z.string().nullable().optional(), position: z.tuple([z.number(), z.number(), z.number()]).optional() }).parse(req.body);
    await q(
      "update hotspots set title=coalesce($2,title), body=coalesce($3,body), position=coalesce($4,position), auto=false where id=$1",
      [(req.params as any).id, b.title ?? null, b.body ?? null, b.position ? JSON.stringify(b.position) : null],
    );
    return { ok: true };
  });

  // ---- analytics ----
  app.get("/api/properties/:id/analytics", { preHandler: admin }, async (req) => {
    const id = (req.params as any).id;
    const totals = await one(
      `select count(distinct session_id) filter (where type='view')::int visits,
              count(*) filter (where type='lead_whatsapp')::int whatsapp,
              count(*) filter (where type='lead_booking')::int booking,
              count(*) filter (where type='share' or type='embed_copy')::int shares,
              count(*) filter (where type='ar_start')::int ar
       from analytics_events where property_id=$1`,
      [id],
    );
    const time = await one(
      `select coalesce(avg(secs),0)::float avg_seconds, coalesce(sum(secs),0)::float total_seconds from (
         select session_id, extract(epoch from max(ts)-min(ts)) secs from analytics_events where property_id=$1 group by session_id) s`,
      [id],
    );
    const daily = await q(
      `select to_char(date_trunc('day', ts),'YYYY-MM-DD') day, count(distinct session_id) filter (where type='view')::int visits,
              count(*) filter (where type like 'lead_%')::int leads
       from analytics_events where property_id=$1 and ts > now() - interval '30 days' group by 1 order by 1`,
      [id],
    );
    const modes = await q(
      `select meta->>'mode' mode, count(*)::int n from analytics_events where property_id=$1 and type='mode_change' group by 1 order by 2 desc`,
      [id],
    );
    return { ...totals, ...time, daily, modes };
  });

  // ---- sources & agencies ----
  app.get("/api/sources", { preHandler: admin }, async () => q("select * from scrape_sources order by domain"));
  app.post("/api/sources", { preHandler: admin }, async (req) => {
    const b = z.object({ domain: z.string().min(3), adapter: z.string().default("generic"), rightsConfirmed: z.boolean().default(false), confirmedBy: z.string().optional(), rateLimitMs: z.number().int().min(500).default(2500), notes: z.string().optional() }).parse(req.body);
    return one(
      `insert into scrape_sources(domain, adapter, rights_confirmed, confirmed_by, confirmed_at, rate_limit_ms, notes)
       values ($1,$2,$3,$4, case when $3 then now() end, $5, $6)
       on conflict (domain) do update set adapter=excluded.adapter, rights_confirmed=excluded.rights_confirmed, confirmed_by=excluded.confirmed_by,
         confirmed_at=excluded.confirmed_at, rate_limit_ms=excluded.rate_limit_ms, notes=excluded.notes returning *`,
      [b.domain.toLowerCase().replace(/^www\./, ""), b.adapter, b.rightsConfirmed, b.confirmedBy ?? null, b.rateLimitMs, b.notes ?? null],
    );
  });

  app.get("/api/agencies", async () => q("select id, slug, name, theme, whatsapp, booking_url as \"bookingUrl\", website from agencies order by name"));
  app.patch("/api/agencies/:slug", { preHandler: admin }, async (req) => {
    const b = z.object({ name: z.string().optional(), theme: AgencyTheme.partial().optional(), whatsapp: z.string().nullable().optional(), bookingUrl: z.string().nullable().optional() }).parse(req.body);
    await q(
      `update agencies set name=coalesce($2,name), theme = theme || $3::jsonb, whatsapp=coalesce($4,whatsapp), booking_url=coalesce($5,booking_url) where slug=$1`,
      [(req.params as any).slug, b.name ?? null, JSON.stringify(b.theme ?? {}), b.whatsapp ?? null, b.bookingUrl ?? null],
    );
    return one("select * from agencies where slug=$1", [(req.params as any).slug]);
  });

  app.get("/api/providers", { preHandler: admin }, async () => {
    const vision = process.env.VISION_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "heuristic");
    let reconstruction: unknown = null;
    try {
      reconstruction = (await Promise.race([runPy("providers.describe", {}, 8000), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000))]) as any).providers;
    } catch (e) {
      reconstruction = { error: `python worker not reachable: ${(e as Error).message}` };
    }
    return { vision, reconstruction, maps: { google3dTiles: !!process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY, mapbox: !!process.env.NEXT_PUBLIC_MAPBOX_TOKEN } };
  });

  // ---- public ----
  app.get("/api/p/:slug", async (req, reply) => {
    const t = await propertyTree({ slug: (req.params as any).slug });
    const preview = (req.query as any)?.preview;
    const isAdmin = !env.adminToken || preview === env.adminToken;
    if (!t || (t.status !== "published" && !isAdmin)) return reply.code(404).send({ error: "not found" });
    reply.header("cache-control", "public, max-age=30");
    return t;
  });

  app.get("/api/published", async () =>
    q(`select p.slug, p.title, p.location, p.price, p.currency, p.price_text as "priceText",
        (select thumb_key from media_assets m where m.property_id=p.id and m.kind in ('image','frame') and m.classification->>'class' in ('exterior','interior') order by (m.classification->>'class'='exterior') desc, sort limit 1) thumb
       from properties p where status='published' order by published_at desc`).then((rows) =>
      rows.map(({ thumb, ...r }) => ({ ...r, thumbUrl: thumb ? `${env.publicApiUrl}/files/${thumb}` : null })),
    ),
  );

  const Event = z.object({ sessionId: z.string().min(6).max(64), type: AnalyticsEventType, meta: z.record(z.string(), z.unknown()).optional() });
  app.post("/api/p/:slug/events", async (req, reply) => {
    const b = Event.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "bad event" });
    const p = await one("select id from properties where slug=$1", [(req.params as any).slug]);
    if (!p) return reply.code(404).send();
    await q("insert into analytics_events(property_id, session_id, type, meta) values ($1,$2,$3,$4)", [p.id, b.data.sessionId, b.data.type, JSON.stringify(b.data.meta ?? {})]);
    return reply.code(204).send();
  });

  return app;
}
