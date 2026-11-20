import type { AgencyTheme, FacadeSpec, PhotoFacade, PlanSpec, Provenance } from "@pv/shared";

export interface ArtifactRef {
  id: string;
  kind: "shell_glb" | "splat" | "panorama" | "texture" | "world" | "massing";
  url: string;
  provider: string;
  provenance: Provenance;
  meta: Record<string, any>;
}

export interface RoomRef {
  id: string;
  planRoomId: string;
  name: string;
  type: string;
  sqm: number | null;
  materials: Record<string, any>;
  artifacts: ArtifactRef[];
  mediaIds: string[];
}

export interface FloorRef {
  id: string;
  level: number;
  name: string;
  elevation: number;
  planStatus: "missing" | "parsed" | "needs_review" | "edited" | "generated" | "authored";
  plan: PlanSpec | null;
  sourceMediaId: string | null;
  artifacts: ArtifactRef[];
  units: { id: string; code: string; bedrooms: number | null; sqm: number | null; price: number | null; availability: string | null }[];
  rooms: RoomRef[];
}

export interface BuildingRef {
  id: string;
  name: string;
  floorsCount: number;
  unitFloorIndex: number | null;
  massing: {
    facadeColor?: string;
    facadeFromPhoto?: boolean;
    roof?: string;
    facade?: FacadeSpec | null;
    photoFacades?: PhotoFacade[];
    buildingType?: string | null;
    heroMediaId?: string | null;
    photoMediaIds?: string[];
    floorsCount?: number;
    contextFloors?: number;
    provenance?: Provenance;
  };
  artifacts: ArtifactRef[];
  floors: FloorRef[];
}

export interface MediaRef {
  id: string;
  kind: string;
  url: string;
  thumbUrl: string;
  sourceUrl: string | null;
  width: number | null;
  height: number | null;
  classification: any;
  confidence: number | null;
  floorId: string | null;
  roomId: string | null;
  parentId: string | null;
}

export interface HotspotRef {
  id: string;
  floorId: string | null;
  roomId: string | null;
  kind: "room" | "price" | "availability" | "view" | "material" | "amenity" | "info";
  position: [number, number, number];
  title: string;
  body: string | null;
}

export interface Property {
  id: string;
  slug: string;
  status: string;
  title: string;
  price: number | null;
  currency: string | null;
  priceText: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  sqm: number | null;
  availability: string | null;
  description: string | null;
  features: string[];
  reference: string | null;
  sourceUrl: string | null;
  sourceAdapter: string | null;
  agency: {
    id: string;
    slug: string;
    name: string;
    theme: AgencyTheme;
    whatsapp: string | null;
    bookingUrl: string | null;
    website: string | null;
  } | null;
  buildings: BuildingRef[];
  media: MediaRef[];
  artifacts: ArtifactRef[];
  hotspots: HotspotRef[];
  jobs?: any[];
}

export type ViewMode = "exterior" | "dollhouse" | "plan" | "walk" | "pano";
