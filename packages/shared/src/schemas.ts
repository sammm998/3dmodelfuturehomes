import { z } from "zod";

/** Where a piece of 3D/visual content came from. Drives the honesty labels in the UI. */
export const Provenance = z.enum([
  "measured", // derived geometrically from a floor plan (scale may be estimated)
  "reconstructed", // reconstructed from real captures (splats, stitched panoramas)
  "ai_generated", // produced by a generative model
  "illustrative", // library furniture, procedural textures, generated layouts
]);
export type Provenance = z.infer<typeof Provenance>;

export const Vec2 = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2>;

export const RoomType = z.enum([
  "living",
  "kitchen",
  "dining",
  "bedroom",
  "bathroom",
  "wc",
  "hall",
  "office",
  "storage",
  "laundry",
  "terrace",
  "balcony",
  "garage",
  "stairs",
  "other",
]);
export type RoomType = z.infer<typeof RoomType>;

export const Wall = z.object({
  id: z.string(),
  a: Vec2,
  b: Vec2,
  thickness: z.number().positive(),
  exterior: z.boolean().default(false),
});
export type Wall = z.infer<typeof Wall>;

export const Opening = z.object({
  id: z.string(),
  wallId: z.string(),
  type: z.enum(["door", "window", "opening", "sliding"]),
  /** centre position along the wall, 0..1 from a to b */
  t: z.number().min(0).max(1),
  width: z.number().positive(),
  sill: z.number().min(0).default(0),
  head: z.number().positive().default(2.1),
});
export type Opening = z.infer<typeof Opening>;

export const RoomMaterials = z.object({
  floor: z
    .object({
      kind: z.enum(["wood", "tile", "stone", "concrete", "carpet", "unknown"]),
      color: z.string(),
      textureKey: z.string().optional(),
      provenance: Provenance,
    })
    .optional(),
  walls: z.object({ color: z.string(), provenance: Provenance }).optional(),
});
export type RoomMaterials = z.infer<typeof RoomMaterials>;

export const PlanRoom = z.object({
  id: z.string(),
  name: z.string(),
  type: RoomType,
  polygon: z.array(Vec2).min(3),
  areaM2: z.number().nonnegative(),
  materials: RoomMaterials.optional(),
});
export type PlanRoom = z.infer<typeof PlanRoom>;

/**
 * PlanSpec: single source of truth for a floor's geometry, in metres.
 * Plan x → world x, plan y → world z. Origin roughly at the footprint centre.
 */
export const PlanSpec = z.object({
  version: z.literal(1),
  ceilingHeight: z.number().positive().default(2.7),
  slabThickness: z.number().positive().default(0.25),
  walls: z.array(Wall),
  openings: z.array(Opening),
  rooms: z.array(PlanRoom),
  stairs: z.array(z.object({ polygon: z.array(Vec2) })).default([]),
  scale: z.object({
    metersPerPixel: z.number().positive().nullable(),
    source: z.enum(["dimension", "area", "wall_thickness", "default", "manual", "authored"]),
  }),
  /** source image used to derive this plan (editor underlay) */
  underlay: z
    .object({
      mediaId: z.string().optional(),
      url: z.string().optional(),
      widthPx: z.number(),
      heightPx: z.number(),
      /** world position of the image's top-left pixel, in metres */
      originM: Vec2,
      metersPerPixel: z.number(),
    })
    .nullable()
    .default(null),
  confidence: z.number().min(0).max(1),
  provenance: Provenance,
  notes: z.array(z.string()).default([]),
});
export type PlanSpec = z.infer<typeof PlanSpec>;
export type PlanSpecInput = z.input<typeof PlanSpec>;

export const ImageClass = z.enum([
  "exterior",
  "interior",
  "floorplan",
  "view",
  "amenity",
  "other",
]);
export type ImageClass = z.infer<typeof ImageClass>;

export const AmenityType = z.enum(["pool", "gym", "rooftop", "garden", "spa", "parking", "lobby", "other"]);

export const ImageClassification = z.object({
  class: ImageClass,
  roomType: RoomType.nullable(),
  amenity: AmenityType.nullable(),
  confidence: z.number().min(0).max(1),
  caption: z.string(),
  /** for floor plans: e.g. "Ground floor", "Level 2" */
  levelHint: z.string().nullable(),
});
export type ImageClassification = z.infer<typeof ImageClassification>;

export const ListingRaw = z.object({
  sourceUrl: z.string().url(),
  adapter: z.string(),
  title: z.string(),
  price: z.number().nullable(),
  currency: z.string().nullable(),
  priceText: z.string().nullable(),
  location: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  bedrooms: z.number().nullable(),
  bathrooms: z.number().nullable(),
  sqm: z.number().nullable(),
  floors: z.number().nullable(),
  description: z.string().nullable(),
  images: z.array(z.object({ url: z.string(), alt: z.string().nullable(), width: z.number().nullable() })),
  floorplans: z.array(z.object({ url: z.string(), label: z.string().nullable() })),
  videos: z.array(z.object({ url: z.string(), kind: z.enum(["file", "youtube", "vimeo", "other"]) })),
  features: z.array(z.string()),
  reference: z.string().nullable(),
});
export type ListingRaw = z.infer<typeof ListingRaw>;

export const AgencyTheme = z.object({
  primary: z.string().default("#1a365d"),
  accent: z.string().default("#c9a227"),
  background: z.string().default("#0b1526"),
  text: z.string().default("#ffffff"),
  fontHeading: z.string().default("'Playfair Display', Georgia, serif"),
  fontBody: z.string().default("Inter, system-ui, sans-serif"),
  logoUrl: z.string().nullable().default(null),
});
export type AgencyTheme = z.infer<typeof AgencyTheme>;

export const JobStepStatus = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type JobStepStatus = z.infer<typeof JobStepStatus>;

export const PIPELINE_STEPS = [
  { key: "fetch", label: "Fetching listing…" },
  { key: "ingest", label: "Downloading images, plans and video…" },
  { key: "classify", label: "Classifying images…" },
  { key: "structure", label: "Building property structure…" },
  { key: "floorplan", label: "Parsing floor plans…" },
  { key: "match", label: "Matching photos to rooms…" },
  { key: "materials", label: "Extracting materials…" },
  { key: "panorama", label: "Building 360° panoramas…" },
  { key: "splat", label: "Photoreal reconstruction (Gaussian Splatting)…" },
  { key: "exterior", label: "Modelling exterior…" },
  { key: "bake", label: "Building 3D…" },
  { key: "hotspots", label: "Placing hotspots…" },
] as const;
export type PipelineStepKey = (typeof PIPELINE_STEPS)[number]["key"];

export const JobStep = z.object({
  key: z.string(),
  label: z.string(),
  status: JobStepStatus,
  message: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});
export type JobStep = z.infer<typeof JobStep>;

export const AnalyticsEventType = z.enum([
  "view",
  "heartbeat",
  "mode_change",
  "floor_change",
  "hotspot",
  "lead_whatsapp",
  "lead_booking",
  "share",
  "embed_copy",
  "ar_start",
]);
export type AnalyticsEventType = z.infer<typeof AnalyticsEventType>;

export const HotspotKind = z.enum(["room", "price", "availability", "view", "material", "amenity", "info"]);
export const Hotspot = z.object({
  id: z.string(),
  floorId: z.string().nullable(),
  roomId: z.string().nullable(),
  kind: HotspotKind,
  position: z.tuple([z.number(), z.number(), z.number()]),
  title: z.string(),
  body: z.string().nullable(),
});
export type Hotspot = z.infer<typeof Hotspot>;

const Hex = z.string().describe("#rrggbb");
/** Exterior description read from listing photos (vision model). Drives the 3D facade, roof and extras. */
export const FacadeSpec = z.object({
  storeys: z.number().describe("visible storeys above ground, including the ground floor"),
  roof: z.enum(["flat", "gable", "hip", "shed", "mansard"]),
  roofMaterial: z.enum(["membrane", "concrete", "clay_tiles", "slate", "metal"]),
  roofColor: Hex,
  wallMaterial: z.enum(["render", "stone", "brick", "wood", "concrete", "glass"]),
  wallColor: Hex,
  accentMaterial: z.enum(["none", "stone", "wood", "brick", "concrete", "metal"]),
  accentColor: Hex,
  accentPlacement: z.enum(["none", "ground_floor", "upper_floor", "entrance_wall"]),
  windowStyle: z.enum(["punched", "large_glazing", "floor_to_ceiling"]),
  windowFrameColor: Hex,
  shutters: z.boolean(),
  shutterColor: Hex,
  balconies: z.enum(["none", "glass", "metal", "masonry"]),
  roofTerrace: z.boolean(),
  pergola: z.boolean(),
  pool: z.boolean(),
  garden: z.boolean(),
  style: z.string().describe("2-4 words, e.g. 'modern mediterranean villa'"),
  confidence: z.number(),
});
export type FacadeSpec = z.infer<typeof FacadeSpec>;

/** Where each building facade is in each exterior photo (normalised image coords, 0..1). */
export const FacadeQuad = z.object({
  imageIndex: z.number().describe("index of the photo in the order given"),
  side: z.enum(["front", "left", "right", "back"]).describe("which side of the building this facade is, relative to the main/entrance facade"),
  /** outline of the whole facade plane from ground to roof edge: top-left, top-right, bottom-right, bottom-left */
  corners: z.array(z.array(z.number())).describe("[[x,y] top-left, top-right, bottom-right, bottom-left], normalised 0..1, x right, y down"),
  storeys: z.number(),
  visibleShare: z.number().describe("0..1 how much of this facade is visible / unobstructed"),
});
export type FacadeQuad = z.infer<typeof FacadeQuad>;
export const FacadeQuads = z.object({
  buildingType: z.enum(["house", "apartment_building", "townhouse_row", "other"]),
  storeys: z.number(),
  quads: z.array(FacadeQuad),
});
export type FacadeQuads = z.infer<typeof FacadeQuads>;

/** A rectified photo of one building side, used as a texture on the exterior model. */
export interface PhotoFacade {
  side: "front" | "left" | "right" | "back";
  key: string;
  aspect: number; // width / height of the rectified facade
  mediaId: string;
}
