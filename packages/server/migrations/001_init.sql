-- PropertyVerse schema
create extension if not exists pgcrypto;

create table if not exists agencies (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  theme jsonb not null default '{}'::jsonb,
  whatsapp text,
  booking_url text,
  website text,
  created_at timestamptz not null default now()
);

-- Domains we may scrape. Nothing is fetched unless rights_confirmed = true.
create table if not exists scrape_sources (
  id uuid primary key default gen_random_uuid(),
  domain text unique not null,
  adapter text not null default 'generic',
  rights_confirmed boolean not null default false,
  confirmed_by text,
  confirmed_at timestamptz,
  rate_limit_ms integer not null default 2500,
  notes text
);

create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references agencies(id) on delete set null,
  slug text unique not null,
  status text not null default 'draft' check (status in ('draft','processing','review','published','unpublished','failed')),
  source_url text,
  source_adapter text,
  title text not null default 'Untitled property',
  price numeric,
  currency text,
  price_text text,
  location text,
  lat double precision,
  lng double precision,
  bedrooms integer,
  bathrooms integer,
  sqm numeric,
  availability text,
  description text,
  features jsonb not null default '[]'::jsonb,
  reference text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists buildings (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  name text not null default 'Main building',
  floors_count integer not null default 1,
  -- index of the floor the listing unit is on (apartments), null for whole buildings
  unit_floor_index integer,
  massing jsonb not null default '{}'::jsonb
);

create table if not exists floors (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references buildings(id) on delete cascade,
  level integer not null,
  name text not null,
  elevation_m double precision not null default 0,
  plan_spec jsonb,
  plan_status text not null default 'missing' check (plan_status in ('missing','parsed','needs_review','edited','generated','authored')),
  source_media_id uuid,
  unique (building_id, level)
);

create table if not exists units (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references floors(id) on delete cascade,
  code text not null,
  bedrooms integer,
  sqm numeric,
  price numeric,
  availability text
);

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references floors(id) on delete cascade,
  unit_id uuid references units(id) on delete set null,
  plan_room_id text not null,
  type text not null,
  name text not null,
  sqm numeric,
  materials jsonb not null default '{}'::jsonb,
  best_layer text not null default 'A',
  unique (floor_id, plan_room_id)
);

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  building_id uuid references buildings(id) on delete set null,
  floor_id uuid references floors(id) on delete set null,
  unit_id uuid references units(id) on delete set null,
  room_id uuid references rooms(id) on delete set null,
  kind text not null check (kind in ('image','video','pdf','floorplan','frame')),
  source_url text,
  s3_key text,
  thumb_key text,
  content_type text,
  width integer,
  height integer,
  bytes integer,
  sha256 text,
  classification jsonb,
  class_confidence double precision,
  sort integer not null default 0,
  parent_id uuid references media_assets(id) on delete cascade,
  created_at timestamptz not null default now()
);
create unique index if not exists media_unique_hash on media_assets(property_id, sha256) where sha256 is not null;

create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  owner_type text not null check (owner_type in ('property','building','floor','room')),
  owner_id uuid not null,
  kind text not null check (kind in ('shell_glb','splat','panorama','texture','world','massing')),
  s3_key text not null,
  bytes integer,
  provider text not null,
  provenance text not null check (provenance in ('measured','reconstructed','ai_generated','illustrative')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists artifacts_owner on artifacts(owner_type, owner_id);

create table if not exists hotspots (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  floor_id uuid references floors(id) on delete cascade,
  room_id uuid references rooms(id) on delete cascade,
  kind text not null,
  position jsonb not null,
  title text not null,
  body text,
  auto boolean not null default true
);

create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  property_id uuid references properties(id) on delete cascade,
  type text not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  steps jsonb not null default '[]'::jsonb,
  input jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists analytics_events (
  id bigserial primary key,
  property_id uuid not null references properties(id) on delete cascade,
  session_id text not null,
  type text not null,
  meta jsonb not null default '{}'::jsonb,
  ts timestamptz not null default now()
);
create index if not exists analytics_prop_ts on analytics_events(property_id, ts);

create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());
