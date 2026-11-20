import { buildRectPlan, centerPlan } from "./planBuilder";
import type { PlanSpec } from "./schemas";

/**
 * Demo property used by the seed ("Villa Serena", fictional).
 * Two floors on a 13 x 10 m footprint. Geometry is authored, so provenance is "measured"
 * (as if read from a plan); furniture and materials in the viewer remain illustrative.
 */
export function demoVillaPlans(): PlanSpec[] {
  const ground = buildRectPlan({
    rooms: [
      { id: "living", name: "Living & dining", type: "living", rect: [0, 0, 8, 6] },
      { id: "kitchen", name: "Kitchen", type: "kitchen", rect: [8, 0, 13, 6] },
      { id: "hall", name: "Entrance hall", type: "hall", rect: [0, 6, 4, 10] },
      { id: "stairs", name: "Stairs", type: "stairs", rect: [4, 6, 6, 10] },
      { id: "wc", name: "Guest WC", type: "wc", rect: [6, 6, 8, 8.2] },
      { id: "storage", name: "Storage", type: "storage", rect: [6, 8.2, 8, 10] },
      { id: "guest", name: "Guest bedroom", type: "bedroom", rect: [8, 6, 13, 10] },
    ],
    doors: [
      ["hall", "OUTSIDE"],
      ["hall", "living", "opening"],
      ["living", "kitchen", "opening"],
      ["living", "OUTSIDE", "sliding"],
      ["stairs", "hall", "opening"],
      ["wc", "living"],
      ["storage", "stairs"],
      ["guest", "kitchen"],
    ],
    ceilingHeight: 2.9,
    provenance: "measured",
    confidence: 1,
    notes: ["Demo data: fictional property for local development."],
  });
  const upper = buildRectPlan({
    rooms: [
      { id: "master", name: "Master bedroom", type: "bedroom", rect: [0, 0, 6, 6] },
      { id: "ensuite", name: "En-suite", type: "bathroom", rect: [6, 0, 8.5, 3.5] },
      { id: "bath2", name: "Bathroom", type: "bathroom", rect: [6, 3.5, 8.5, 6] },
      { id: "bed2", name: "Bedroom 2", type: "bedroom", rect: [8.5, 0, 13, 6] },
      { id: "landing", name: "Landing", type: "hall", rect: [0, 6, 4, 10] },
      { id: "stairs", name: "Stairs", type: "stairs", rect: [4, 6, 6, 10] },
      { id: "corridor", name: "Corridor", type: "hall", rect: [6, 6, 13, 7.5] },
      { id: "bed3", name: "Bedroom 3", type: "bedroom", rect: [6, 7.5, 13, 10] },
    ],
    doors: [
      ["master", "landing"],
      ["ensuite", "master"],
      ["bath2", "corridor"],
      ["bed2", "corridor"],
      ["bed3", "corridor"],
      ["stairs", "landing", "opening"],
      ["stairs", "corridor", "opening"],
    ],
    ceilingHeight: 2.7,
    provenance: "measured",
    confidence: 1,
    notes: ["Demo data: fictional property for local development."],
  });
  // both floors share the same footprint, so centring each keeps them aligned
  return [centerPlan(ground), centerPlan(upper)];
}
