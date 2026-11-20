# PropertyVerse: architecture plan (draft for approval)

Status: **implemented** (see README.md for how to run it and the current limitations). Original plan below.

---

## 1. Core design decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Monorepo** (pnpm workspaces + Turborepo) with `apps/web`, `apps/api`, `workers/node`, `workers/py`, `packages/*` | One `docker compose up`; shared types between API, viewer and Node workers |
| D2 | **A "PlanSpec" JSON is the single source of truth for geometry.** It holds walls (centre-line + thickness), openings (doors/windows with sill/head height), room polygons with labels, scale (m/px), floor heights and the stacking of floors | Layer A must always work. The 2D editor, the 3D viewer and the bake worker all read the same spec. Correcting a wall in 2D updates 3D instantly, with no rebake |
| D3 | **Two render paths for the shell.** (a) the viewer extrudes PlanSpec in the browser (instant, used in the editor and MVP); (b) a worker bakes an optimised GLB (merged meshes, lightmap UVs, baked AO/lightmaps, Draco + KTX2) for published properties | Fast iteration plus production performance (60 fps desktop / 30 fps iPad) |
| D4 | **Every 3D asset carries `provenance`**: `measured` (from the floor plan), `reconstructed` (splat/photogrammetry from real captures), `ai_generated`, `illustrative` (library furniture, generic textures) | Drives the honest "Visualisation" labels in the UI automatically |
| D5 | **`ReconstructionProvider` interface** (Python, mirrored as a TS type) with pluggable implementations: `floorplan_extrude`, `gsplat_local`, `external_splat_api`, `image_to_world_api`, `panorama_stitch`, `panorama_generate` | Providers can be swapped and the best available layer chosen per room |
| D6 | **BullMQ flows** (parent job → step children) with step status published to Redis pub/sub → API → **SSE** to the browser | "Fetching images… / Parsing floor plan… / Building 3D…" in real time |
| D7 | Python workers consume BullMQ directly via the official `bullmq` Python package | No extra broker; same retry and back-off semantics |
| D8 | **Vision model behind a `VisionProvider` interface** (Claude by default, with OpenAI as a fallback) | Classification and floor plan parsing are not locked to one vendor |
| D9 | **Scraping is opt-in per domain** (`scrape_sources` table with `rights_confirmed`), checks robots.txt, applies a per-domain rate limit and identifies itself in the User-Agent | Meets the rights and robots requirement by construction |

---

## 2. System overview

```
           ┌──────────────────────── apps/web (Next.js 15, R3F) ───────────────────────┐
           │ /new (URL or upload)  /admin/*  /p/[slug] viewer  /embed/[slug]  /booth/[slug] │
           └───────────────┬───────────────────────────────▲───────────────────────────┘
                           │ REST + presigned uploads      │ SSE job status, GLB/splat via CDN
                    ┌──────▼───────────────────────────────┴──────┐
                    │ apps/api (Fastify + TS, Drizzle, zod)        │
                    └──────┬───────────────┬───────────────────────┘
                     Postgres          Redis (BullMQ)         S3 / MinIO
                           │               │                      ▲
          ┌────────────────┴──┐   ┌────────┴──────────────────────┴────────────────┐
          │ workers/node (TS) │   │ workers/py (Python 3.11)                         │
          │ • scrape (Playwr.)│   │ • floorplan_parse  (OpenCV + vision LLM)         │
          │ • classify (LLM)  │   │ • shell_bake       (trimesh/shapely → GLB)        │
          │ • media ingest    │   │ • materials        (colour/material extraction)  │
          │   (sharp, ffmpeg) │   │ • panorama         (stitch / generate)           │
          │ • glb_optimize    │   │ • splat            (nerfstudio/gsplat, GPU queue)│
          │   (gltf-transform)│   │ • massing          (exterior volume)             │
          └───────────────────┘   └──────────────────────────────────────────────────┘
```

### Import pipeline (BullMQ flow)
1. `scrape` → site adapter (or the generic fallback) → `ListingRaw` (title, price, location, beds, sqm, description, image/plan/video URLs, coordinates)
2. `media.ingest` → download the highest resolution, hash/dedupe, generate thumbnails, extract video keyframes (ffmpeg), rasterise PDF pages
3. `classify` → the vision model labels each image: `exterior | interior:<room_type> | floorplan | view | amenity:<pool|gym|rooftop|…> | other`, with confidence
4. `structure` → build Property → Buildings → Floors → Units → Rooms (from listing data + floor plans)
5. `floorplan.parse` → PlanSpec per floor (status `needs_review` if confidence is low)
6. `match` → room photos → rooms (vision model with the room list as context)
7. `reconstruct` → for each room/floor, pick the best available layer (C → B → A, with D as the room fallback)
8. `bake` → GLB + Draco/KTX2 + LODs → S3 → `artifacts` rows

---

## 3. Data model (Postgres, Drizzle)

```
agencies(id, name, slug, theme jsonb{primary,accent,logo,fonts}, whatsapp, booking_url)
scrape_sources(id, domain, adapter, rights_confirmed bool, confirmed_by, rate_limit_ms, notes)
properties(id, agency_id, slug, status[draft|processing|review|published|unpublished],
           source_url, title, price, currency, location jsonb, lat, lng, description,
           bedrooms, bathrooms, sqm, availability, created_at, published_at)
buildings(id, property_id, name, floors_count, footprint geojson, massing jsonb)
floors(id, building_id, level int, name, elevation_m, ceiling_height_m, plan_spec jsonb, plan_status)
units(id, floor_id, code, bedrooms, sqm, price, availability)
rooms(id, floor_id, unit_id?, type, name, polygon jsonb, sqm, materials jsonb, best_layer)
media_assets(id, property_id, building_id?, floor_id?, unit_id?, room_id?,
             kind[image|video|pdf|floorplan], source_url, s3_key, width, height, sha256,
             classification, class_confidence, provenance)
artifacts(id, owner_type, owner_id, kind[shell_glb|furnished_glb|splat|panorama|texture|massing_glb],
          s3_key, lod, bytes, provider, provenance[measured|reconstructed|ai_generated|illustrative], meta jsonb)
hotspots(id, property_id, floor_id?, room_id?, position vec3, kind, payload jsonb)
jobs(id, property_id, type, status, progress, steps jsonb, error, started_at, finished_at)
analytics_events(id, property_id, session_id, type[view|mode_change|hotspot|lead_whatsapp|lead_booking|share|heartbeat], meta, ts)
```

---

## 4. Viewer (apps/web)

- **Stack:** Next.js 15 (App Router), React Three Fiber, drei, `@react-three/postprocessing` (N8AO/SSAO, bloom, ACES/AgX tone mapping), `@react-three/xr` (AR hit-test placement and VR), `three-mesh-bvh` (collisions), a Gaussian-splat renderer (Spark or `@mkkellogg/gaussian-splats-3d`, chosen during that phase), `3d-tiles-renderer` for Google Photorealistic 3D Tiles or Mapbox GL, `suncalc` for the sun position, and zustand for state.
- **Modes**, each a camera rig with tweened transitions: `exterior` (orbit/drone), `dollhouse` (floors above the selected one hidden, a clipping plane at ceiling height), `plan2d` (orthographic top view with labels and sqm), `walk` (first-person with capsule-vs-BVH collision; WASD + pointer lock, nipplejs joystick on touch, click-to-move with a floor raycast), `pano360` (equirectangular sphere with links to other rooms).
- **Performance:** LODs, Draco/KTX2 (loaders from drei), progressive loading (exterior massing → current floor → other floors), adaptive DPR (`PerformanceMonitor`), and post-processing switched off on low tiers.
- **Booth mode** (`/booth/[slug]`): fullscreen, a scripted camera spline tour that loops, idle reset, a QR code to the listing, and a cursor that hides itself.
- **White-label:** theme tokens from `agencies.theme` as CSS variables (Future Homes: navy `#1a365d`). WhatsApp (`wa.me`) and "Book a viewing" buttons, a share link and an `<iframe>` embed snippet.
- **Honesty:** a provenance badge on the active view (for example "Visualisation: furniture and materials are illustrative") and a legend in the info panel.

## 5. Floor plan → 3D (Layer A, the baseline)
1. Rasterise the plan (PDF via pdfium/PyMuPDF), deskew it and binarise it.
2. **CV pass:** detect thick wall strokes with morphology, then Hough lines/LSD, snap to the dominant axes and merge collinear segments.
3. **Vision LLM pass:** room labels, dimension annotations, door/window symbols and "is this one or several units". The result is a structured JSON constrained by a schema.
4. **Fusion:** align the LLM rooms to the CV wall graph, build room polygons with shapely `polygonize`, and set the scale from the dimension annotations, or failing that from the listing's sqm against the polygon area.
5. Output a PlanSpec with confidence values. A low-confidence result goes to the 2D editor (Konva: drag wall endpoints, add or remove openings, rename rooms).
6. Extrude to walls with openings (CSG-free: wall segments split around openings, plus lintels and sills), floor and ceiling slabs, and a default ceiling height of 2.7 m that can be edited.

## 6. Later layers (B/C/D, exterior)
- **B. Materials and furniture:** dominant floor and wall colour and material class per matched photo (segmentation + vision LLM) → match to a CC0 PBR library (ambientCG/Poly Haven) and tint it, with optional AI-generated tileable textures. Furniture: the LLM proposes a layout per room type; place GLBs from the library with simple constraint rules (along walls, clear of doors). All of this is marked `illustrative`.
- **C. Photorealism:** `gsplat_local` (nerfstudio `splatfacto` on a GPU queue, with COLMAP poses from video frames) and `external_*` providers behind the same interface. Splats are aligned to the PlanSpec through user-picked correspondences or ICP against the shell.
- **D. 360°:** stitch with OpenCV when overlapping photos exist, otherwise generate a panorama (external API, marked `ai_generated`). Hotspots link rooms through the adjacency in the PlanSpec.
- **Exterior:** massing = the footprint (from map data if available, otherwise estimated) × the number of floors from the listing, with façade colour and materials from the exterior photos. Placed on 3D tiles or a map at the listing's lat/lng, with `suncalc` lighting.

---

## 7. Folder structure

```
propertyverse/
├─ apps/
│  ├─ web/                    Next.js: viewer, admin, upload, embed, booth
│  │  ├─ app/(public)/p/[slug]  app/embed/[slug]  app/booth/[slug]  app/admin/…  app/new
│  │  ├─ components/viewer/   Scene, modes/{Exterior,Dollhouse,Plan2D,Walk,Pano360}, FloorSelector, Hotspots, ProvenanceBadge
│  │  ├─ components/editor/   PlanEditor (Konva)
│  │  └─ lib/                 plan-to-mesh.ts, collisions.ts, theme.ts, analytics.ts
│  └─ api/                    Fastify: routes/, db/ (drizzle schema + migrations), queues/, s3/, sse/
├─ workers/
│  ├─ node/                   scrape/{adapters/futurehomes.ts, adapters/generic.ts, robots.ts, ratelimit.ts}, classify/, ingest/, optimize/
│  └─ py/                     propertyverse_workers/{floorplan/, geometry/, materials/, panorama/, splat/, massing/, providers/base.py}
│     └─ tests/               floorplan parsing tests with fixture plans + expected PlanSpecs
├─ packages/
│  ├─ shared/                 zod schemas: PlanSpec, ListingRaw, job steps, provenance enums
│  ├─ vision/                 VisionProvider (Claude, OpenAI) + prompts + JSON schemas
│  └─ ui/                     themed primitives
├─ seed/                      demo property: images, floor plan, PlanSpec, pre-baked GLB
├─ docker/                    Dockerfiles (web, api, worker-node, worker-py, worker-py-gpu)
├─ docker-compose.yml         postgres, redis, minio, api, web, worker-node, worker-py (+ gpu profile)
├─ .env.example
└─ README.md
```

---

## 8. External services and API keys

| Service | Needed for | Phase | Required? |
|---|---|---|---|
| **Anthropic API** (`ANTHROPIC_API_KEY`) | Image classification, floor plan parsing, room matching | MVP | **Yes** (or `OPENAI_API_KEY` as the fallback vision provider) |
| Postgres, Redis, MinIO | DB, queue, object storage | MVP | Local in docker compose. In production: any managed Postgres/Redis plus S3/R2 |
| **Google Maps Platform** (`GOOGLE_MAPS_API_KEY`, Map Tiles API) | Photorealistic 3D Tiles around the building | Phase 2 | Optional, but the best result. Billed per tile request |
| Mapbox (`MAPBOX_TOKEN`) *or* Cesium ion (`CESIUM_ION_TOKEN`) | Cheaper map/satellite base | Phase 2 | Alternative to Google |
| GPU compute (RunPod/Modal/own GPU) | Gaussian Splatting training (nerfstudio/gsplat) | Phase 2 | Optional, only for layer C |
| External splat / world-generation API (e.g. World Labs; choose later) | Layer C without your own GPU | Phase 2 | Optional, behind `ReconstructionProvider` |
| Panorama generation API (e.g. Blockade Labs) or an image model | Layer D when no photos can be stitched | Phase 2 | Optional |
| Image-to-3D (e.g. Meshy/Tripo) | Custom furniture GLBs | Phase 3 | Optional, a CC0 library is the default |
| ambientCG / Poly Haven | PBR textures, HDRIs, furniture | Phase 2 | CC0, no key |
| Sentry (`SENTRY_DSN`) | Error tracking | Any | Optional |

WhatsApp leads use `wa.me` deep links (no API). QR codes and analytics are generated and stored locally, so neither needs a key.

---

## 9. Delivery phases
1. **MVP:** compose stack, schema, URL import (Future Homes adapter + generic), classification, PlanSpec parse + 2D editor, viewer (Exterior massing, Dollhouse, floor selector, Plan2D, Walk with collisions), job status over SSE, seed property, tests for the scraper (recorded HTML fixtures) and floor plan parsing.
2. Materials and furniture, 360° fallback, map/3D tiles with sun, GLB bake with Draco/KTX2, admin analytics.
3. Gaussian Splatting providers, WebXR AR/VR, booth mode, embed and white-label polish.

## 10. Open questions / blockers
1. **Content rights:** do you have permission to use content from futurehomesinternational.com (are you Future Homes or acting for them)? The adapter is only enabled once `rights_confirmed` is set.
2. **Network:** this cloud sandbox currently **blocks futurehomesinternational.com** (the proxy refused the connection). Testing against a real listing needs that host added to the environment's allowed hosts. Otherwise I can test against saved HTML fixtures you provide.
3. **Vision key:** only an OpenAI key is connected in this environment. Do you want an Anthropic key added for Claude (as specified), or should the MVP use OpenAI behind the same interface?
4. **Map provider:** Google Photorealistic 3D Tiles (best look, pay-per-use) or Mapbox (cheaper, flatter)?
5. **GPU for splats:** your own or rented GPU (nerfstudio), or an external API?
