// Writes PlanSpec fixtures used by the Python parser tests and the seed.
import { writeFileSync } from "node:fs";
import { buildRectPlan, centerPlan, demoVillaPlans, generateIllustrativePlans } from "../src/index.js";

const out = process.argv[2] ?? "../../workers/py/tests/fixtures";
const simple = centerPlan(
  buildRectPlan({
    rooms: [
      { id: "living", name: "Living", type: "living", rect: [0, 0, 6, 4.5] },
      { id: "bed", name: "Bedroom", type: "bedroom", rect: [6, 0, 10, 4.5] },
      { id: "bath", name: "Bath", type: "bathroom", rect: [6, 4.5, 10, 7] },
      { id: "hall", name: "Hall", type: "hall", rect: [0, 4.5, 6, 7] },
    ],
    doors: [["hall", "OUTSIDE"], ["hall", "living", "opening"], ["hall", "bath"], ["living", "bed"]],
    provenance: "measured",
  }),
);
const [villaGround, villaUpper] = demoVillaPlans();
const [apartment] = generateIllustrativePlans({ sqm: 85, bedrooms: 2, bathrooms: 1 });
for (const [name, plan] of Object.entries({ simple, villa_ground: villaGround, villa_upper: villaUpper, apartment })) {
  writeFileSync(`${out}/${name}.json`, JSON.stringify(plan, null, 1));
}
console.log("fixtures written to", out);
