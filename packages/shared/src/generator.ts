import { buildRectPlan, centerPlan, type RectRoom } from "./planBuilder.js";
import type { PlanSpec } from "./schemas.js";

export interface GeneratorInput {
  sqm: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floors?: number | null;
  ceilingHeight?: number;
}

/**
 * Generate an ILLUSTRATIVE layout when no floor plan is available.
 * This is the "must always work" fallback; it is clearly labelled as illustrative in the UI.
 * Returns one PlanSpec per floor (villas with >=2 floors get bedrooms upstairs).
 */
export function generateIllustrativePlans(input: GeneratorInput): PlanSpec[] {
  const bedrooms = Math.max(0, Math.min(8, Math.round(input.bedrooms ?? 2)));
  const bathrooms = Math.max(1, Math.min(6, Math.round(input.bathrooms ?? Math.max(1, Math.ceil(bedrooms / 2)))));
  const floors = Math.max(1, Math.min(3, Math.round(input.floors ?? 1)));
  const totalSqm = input.sqm && input.sqm > 15 ? input.sqm : 45 + bedrooms * 22;
  const notes = [
    "Illustrative layout generated from listing data (bedrooms, bathrooms, size). Not the actual floor plan.",
  ];

  if (floors === 1 || bedrooms <= 1) {
    return [centerPlan(singleLevel(totalSqm, bedrooms, bathrooms, input.ceilingHeight, notes))];
  }
  // two-level villa: living + kitchen + wc + 1 guest room downstairs; rest upstairs
  const perFloor = totalSqm / 2;
  const ground = groundLevel(perFloor, input.ceilingHeight, notes, bedrooms >= 4);
  const upper = singleLevel(perFloor, bedrooms - (bedrooms >= 4 ? 1 : 0), Math.max(1, bathrooms - 1), input.ceilingHeight, notes, true);
  return [centerPlan(ground), centerPlan(upper)];
}

function dims(area: number, aspect = 1.55) {
  const W = Math.sqrt(area * aspect);
  return { W: round(W), D: round(area / W) };
}
const round = (v: number) => Math.round(v * 20) / 20;

function singleLevel(
  sqm: number,
  bedrooms: number,
  bathrooms: number,
  ceilingHeight: number | undefined,
  notes: string[],
  upper = false,
): PlanSpec {
  const { W, D } = dims(sqm * 0.92);
  const hallD = 1.3;
  const frontD = round((D - hallD) * (upper ? 0.0 : 0.5));
  const backD = round(D - hallD - frontD);
  const rooms: RectRoom[] = [];
  const doors: [string, string, ("door" | "opening" | "sliding")?][] = [];

  if (!upper) {
    const livW = round(W * 0.62);
    rooms.push({ id: "living", name: "Living room", type: "living", rect: [0, 0, livW, frontD] });
    rooms.push({ id: "kitchen", name: "Kitchen", type: "kitchen", rect: [livW, 0, W, frontD] });
    doors.push(["living", "kitchen", "opening"], ["hall", "living", "opening"], ["living", "OUTSIDE", "sliding"]);
  } else {
    // upper level: the stairs block takes the first part of the landing
    rooms.push({ id: "stairs", name: "Stairs", type: "stairs", rect: [0, frontD, 2.4, frontD + hallD] });
    doors.push(["stairs", "hall", "opening"]);
  }
  rooms.push({ id: "hall", name: upper ? "Landing" : "Hall", type: "hall", rect: [upper ? 2.4 : 0, frontD, W, frontD + hallD] });
  if (!upper) doors.push(["hall", "OUTSIDE"]);

  const back: { id: string; name: string; type: RectRoom["type"]; w: number }[] = [];
  for (let i = 0; i < bedrooms; i++)
    back.push({ id: `bed${i + 1}`, name: i === 0 ? "Master bedroom" : `Bedroom ${i + 1}`, type: "bedroom", w: i === 0 ? 1.35 : 1 });
  for (let i = 0; i < bathrooms; i++)
    back.push({ id: `bath${i + 1}`, name: bathrooms > 1 ? `Bathroom ${i + 1}` : "Bathroom", type: "bathroom", w: 0.6 });
  if (!back.length) back.push({ id: "bed1", name: "Bedroom", type: "bedroom", w: 1 });
  // interleave bathrooms between bedrooms for plausibility
  const beds = back.filter((b) => b.type === "bedroom");
  const baths = back.filter((b) => b.type === "bathroom");
  const ordered: typeof back = [];
  while (beds.length || baths.length) {
    if (beds.length) ordered.push(beds.shift()!);
    if (baths.length) ordered.push(baths.shift()!);
  }
  const totalW = ordered.reduce((s, b) => s + b.w, 0);
  let x = 0;
  ordered.forEach((b, i) => {
    const w = i === ordered.length - 1 ? W - x : round((b.w / totalW) * W);
    rooms.push({ id: b.id, name: b.name, type: b.type, rect: [x, frontD + hallD, x + w, frontD + hallD + backD] });
    doors.push(["hall", b.id]);
    x += w;
  });
  return buildRectPlan({
    rooms: rooms.filter((r) => r.rect[3] - r.rect[1] > 0.5 && r.rect[2] - r.rect[0] > 0.5),
    doors,
    ceilingHeight: ceilingHeight ?? 2.7,
    provenance: "illustrative",
    confidence: 0.2,
    notes,
  });
}

function groundLevel(sqm: number, ceilingHeight: number | undefined, notes: string[], guestRoom: boolean): PlanSpec {
  const { W, D } = dims(sqm * 0.92);
  const frontD = round(D * 0.58);
  const backD = round(D - frontD);
  const livW = round(W * 0.6);
  const rooms: RectRoom[] = [
    { id: "living", name: "Living & dining", type: "living", rect: [0, 0, livW, frontD] },
    { id: "kitchen", name: "Kitchen", type: "kitchen", rect: [livW, 0, W, frontD] },
    { id: "hall", name: "Entrance hall", type: "hall", rect: [0, frontD, round(W * 0.4), frontD + backD] },
    { id: "stairs", name: "Stairs", type: "stairs", rect: [round(W * 0.4), frontD, round(W * 0.55), frontD + backD] },
    { id: "wc", name: "Guest WC", type: "wc", rect: [round(W * 0.55), frontD, round(W * 0.68), frontD + backD] },
    guestRoom
      ? { id: "guest", name: "Guest bedroom", type: "bedroom", rect: [round(W * 0.68), frontD, W, frontD + backD] }
      : { id: "office", name: "Study", type: "office", rect: [round(W * 0.68), frontD, W, frontD + backD] },
  ];
  return buildRectPlan({
    rooms,
    doors: [
      ["hall", "OUTSIDE"],
      ["hall", "living", "opening"],
      ["living", "kitchen", "opening"],
      ["living", "OUTSIDE", "sliding"],
      ["stairs", "living", "opening"],
      ["wc", "kitchen"],
      [guestRoom ? "guest" : "office", "kitchen"],
    ],
    ceilingHeight: ceilingHeight ?? 2.8,
    provenance: "illustrative",
    confidence: 0.2,
    notes,
  });
}
