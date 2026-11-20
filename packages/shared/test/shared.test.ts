import { describe, expect, it } from "vitest";
import {
  buildRectPlan,
  collisionSegments,
  generateIllustrativePlans,
  layoutFurniture,
  moveWithCollisions,
  PlanSpec,
  roomAdjacency,
  splitWall,
} from "../src/index.js";

const twoRooms = () =>
  buildRectPlan({
    rooms: [
      { id: "a", name: "A", type: "living", rect: [0, 0, 4, 4] },
      { id: "b", name: "B", type: "bedroom", rect: [4, 0, 7, 4] },
    ],
    doors: [["a", "b"], ["a", "OUTSIDE"]],
    provenance: "measured",
  });

describe("buildRectPlan", () => {
  it("creates exterior and shared interior walls", () => {
    const p = twoRooms();
    expect(PlanSpec.parse(p)).toBeTruthy();
    const interior = p.walls.filter((w) => !w.exterior);
    expect(interior).toHaveLength(1);
    expect(interior[0].a[0]).toBe(4);
    expect(p.walls.filter((w) => w.exterior).length).toBe(6); // top/bottom split per room + 2 sides
    expect(p.openings.filter((o) => o.type === "door")).toHaveLength(2);
    expect(p.rooms.map((r) => r.areaM2)).toEqual([16, 12]);
  });

  it("links rooms through doors", () => {
    const adj = roomAdjacency(twoRooms());
    expect([...adj.get("a")!]).toEqual(["b"]);
  });
});

describe("splitWall", () => {
  it("splits around a door with a lintel", () => {
    const wall = { id: "w", a: [0, 0] as [number, number], b: [4, 0] as [number, number], thickness: 0.2, exterior: false };
    const pieces = splitWall(wall, [{ id: "o", wallId: "w", type: "door", t: 0.5, width: 1, sill: 0, head: 2.1 }], 2.7);
    expect(pieces.map((p) => [p.s0, p.s1, p.z0, p.z1])).toEqual([
      [0, 1.5, 0, 2.7],
      [1.5, 2.5, 2.1, 2.7],
      [2.5, 4, 0, 2.7],
    ]);
  });
});

describe("collisions", () => {
  it("blocks walking through walls but allows doors", () => {
    const p = twoRooms();
    const segs = collisionSegments(p);
    // walk from room a toward the wall at x=4, away from the door (door at y=2)
    const blocked = moveWithCollisions([3, 0.8], [2, 0], segs);
    expect(blocked[0]).toBeLessThan(4);
    const through = moveWithCollisions([3, 2], [2, 0], segs);
    expect(through[0]).toBeGreaterThan(4.5);
  });
});

describe("generator + furniture", () => {
  it("generates an illustrative villa with two floors", () => {
    const plans = generateIllustrativePlans({ sqm: 220, bedrooms: 4, bathrooms: 3, floors: 2 });
    expect(plans).toHaveLength(2);
    for (const p of plans) {
      expect(PlanSpec.parse(p).provenance).toBe("illustrative");
      expect(layoutFurniture(p).length).toBeGreaterThan(3);
    }
    const bedroomCount = plans.flatMap((p) => p.rooms).filter((r) => r.type === "bedroom").length;
    expect(bedroomCount).toBe(4);
  });
  it("generates an apartment", () => {
    const [p] = generateIllustrativePlans({ sqm: 85, bedrooms: 2, bathrooms: 1 });
    const total = p.rooms.reduce((s, r) => s + r.areaM2, 0);
    expect(total).toBeGreaterThan(65);
    expect(total).toBeLessThan(90);
  });
});
