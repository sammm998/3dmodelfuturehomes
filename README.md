# PropertyVerse

Turns a property listing (URL) or uploaded media (photos, floor plans, PDFs, walkthrough videos) into an
explorable 3D property showcase: **Exterior**, **Dollhouse** with a floor selector and cut-away,
**2D Floor Plan**, **first-person Walkthrough** with collisions, **360° rooms**, hotspots, lead buttons,
white-label themes, an iframe embed, WebXR AR/VR and an **exhibition booth mode**.

```bash
cp .env.example .env        # optional: add ANTHROPIC_API_KEY, map keys
docker compose up --build
```

| URL | |
|---|---|
| http://localhost:3000 | published properties |
| http://localhost:3000/p/villa-serena-demo | demo villa (2 floors) |
| http://localhost:3000/p/mar-azul-2b-demo | demo apartment in a 6-storey building |
| http://localhost:3000/booth/villa-serena-demo | exhibition booth mode |
| http://localhost:3000/embed/villa-serena-demo | iframe embed |
| http://localhost:3000/new | import a URL or upload media |
| http://localhost:3000/admin | review, edit floor plans, publish, analytics |

The seed creates the Future Homes agency (navy `#1a365d` theme) and two **fictional** demo properties, so
everything works offline and without API keys.

## How it works

```
URL ─▶ scrape (Playwright, site adapter) ─┐
upload ───────────────────────────────────┴▶ ingest (dedupe, thumbs, PDF→pages, video→keyframes)
  ▶ classify (vision: exterior / interior:<room> / floorplan / view / amenity)
  ▶ structure (Property → Building → Floors → Units → Rooms)
  ▶ floor plan → PlanSpec (OpenCV + vision labels)   ← editable in the 2D editor
  ▶ match photos → rooms ▶ materials (colours → PBR textures)
  ▶ 360° panoramas ▶ Gaussian splats (if a provider is available)
  ▶ exterior massing & facade ▶ bake GLB (+Draco) ▶ hotspots ▶ review / publish
```

Each step reports live progress over SSE (`Fetching listing…`, `Parsing floor plans…`, `Building 3D…`).

**PlanSpec** (`packages/shared/src/schemas.ts`) is the single source of truth for geometry: walls
(centre-line + thickness), openings (door/window/sliding with sill/head), room polygons, scale and
ceiling height, in metres. The viewer extrudes it live (so 2D edits show in 3D immediately); the Python
worker bakes the same geometry into a GLB (`splitWall` is implemented identically in TS and Python and
tested against each other).

### Reconstruction layers (best available first)

| Layer | What | Provider(s) | Provenance shown to visitors |
|---|---|---|---|
| A | Floor plan → 3D shell (always works) | `floorplan_extrude`; without a plan: illustrative layout from bedrooms/bathrooms/m² | *From floor plan* / *Visualisation* |
| B | Materials & furniture | photo colours → procedural PBR textures; rule-based furniture | *Visualisation* |
| C | Photorealism | `gsplat_local` (nerfstudio splatfacto, GPU), `http_splat`, `http_world` | *Reconstructed* / *AI-generated* |
| D | 360° rooms | `panorama_stitch` (OpenCV), `http_panorama` | *Reconstructed* / *Visualisation* / *AI-generated* |

All providers implement `ReconstructionProvider` (`workers/py/propertyverse_workers/providers/base.py`)
and are chosen per job by availability. Every artifact stores its provenance, and the viewer's badge
(bottom left) lists exactly what is measured, reconstructed, AI-generated or illustrative.

## Repository layout

```
apps/web          Next.js 16 + React Three Fiber viewer, admin, import/upload, booth, embed
apps/api          Fastify API: imports, uploads, jobs (SSE), properties, plans, analytics, /files proxy
workers/node      pipeline orchestrator (BullMQ), Playwright scraper + site adapters, GLB optimisation
workers/py        OpenCV floor plan parser, GLB bake, PBR textures, panoramas, video/PDF, splat providers
packages/shared   PlanSpec & schemas, geometry, collisions, plan builder, layout generator, furniture rules
packages/vision   VisionProvider: Claude (default), OpenAI, offline heuristic
packages/server   Postgres, S3, queues, job progress, repository helpers, SQL migrations
docker/           Dockerfiles (node, py, py-gpu), SeaweedFS S3 config
```

## Local development without Docker for the apps

```bash
docker compose up -d postgres redis s3
pnpm install
python3 -m venv workers/py/.venv && workers/py/.venv/bin/pip install -r workers/py/requirements-dev.txt
cp .env.example .env && set -a && . ./.env && set +a
pnpm db:migrate && pnpm db:seed
(cd workers/py && .venv/bin/python -m propertyverse_workers.worker) &
pnpm dev                      # api :4000, web :3000, pipeline worker
```

## Tests

```bash
pnpm test                     # all TypeScript tests + Python tests
pnpm --filter @pv/worker test # scraper: adapters, URL upgrades, robots.txt, headless JS rendering
cd workers/py && pytest       # floor plan parsing (scale, rooms, openings, labels, noise), bake, textures, panoramas
```

The floor plan tests render PlanSpec fixtures (exported from the TS plan builder with `pnpm fixtures`)
into realistic plan images (walls, door swings, window glazing, labels, furniture outlines) at several
resolutions, parse them back and check scale (±5 %), room count, labels, areas and openings.

## Content rights and scraping

* A URL is only imported if its domain is in **Admin → Sources** with *rights confirmed*.
  The seed confirms `futurehomesinternational.com` for the Future Homes agency (`SEED_CONFIRM_FUTUREHOMES`).
* robots.txt is checked before every page (agent-specific groups; unreachable robots.txt = don't scrape).
* Requests to a domain are spaced by its rate limit (Redis-backed, shared by all workers), with an
  identifying User-Agent (`SCRAPER_USER_AGENT`).
* The `futurehomes` adapter (`workers/node/src/scrape/adapters.ts`) builds on the generic extractor
  (schema.org JSON-LD, OpenGraph, label/value pairs, full-resolution WordPress uploads, lightbox links,
  floor plan sections, PDFs, videos, map coordinates). Its tests run against a synthetic fixture; check it
  once against live pages: `curl -X POST localhost:4000/api/imports -d '{"url":"…"}' -H 'content-type: application/json'`.

## External services

| Service | Used for | Required |
|---|---|---|
| Anthropic API (`ANTHROPIC_API_KEY`) | classification, reading floor plans (room labels, printed areas, levels), photo→room matching, materials | Recommended. Without it a heuristic fallback runs (filename/colour based) and plans are labelled by size |
| OpenAI (`OPENAI_API_KEY`) | alternative vision provider | Optional |
| Google Map Tiles API (`GOOGLE_MAPS_API_KEY`) | Photorealistic 3D Tiles around the building | Optional |
| Mapbox (`MAPBOX_TOKEN`) | satellite ground + address geocoding | Optional |
| GPU (local NVIDIA or rented) | Gaussian Splatting via nerfstudio (`--profile gpu`) | Optional |
| Splat / world-generation / panorama APIs | via the generic HTTP job contract | Optional |

## Performance notes

* Walls of a floor are merged into one geometry with per-face vertex colours; furniture is merged per colour.
* Baked GLBs are deduplicated, welded and Draco-compressed (`gltf-transform`). KTX2 texture compression needs
  the `toktx` binary (not bundled); textures are currently 512 px PNG.
* The viewer degrades automatically (`PerformanceMonitor` → post-processing off, adaptive DPR). Labels are one
  projected DOM layer, not per-label React roots.
* Lighting is real-time (sun from `suncalc` for the property's coordinates and the chosen hour + SSAO);
  lightmap baking is not implemented yet.

## Known limitations

* The floor plan parser handles axis-aligned walls; diagonal/curved walls must be drawn in the editor.
* Exterior massing is an extrusion of the floor plan footprint with a flat roof (illustrative);
  roof shapes and terraces are not reconstructed from photos yet.
* Splat alignment to the plan uses `artifact.meta.transform` (manual); no automatic registration yet.
* With Google 3D Tiles the real existing building also appears in the tiles; flattening the footprint is not done.
