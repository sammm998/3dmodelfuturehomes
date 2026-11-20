import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { HeuristicVision } from "../src/heuristic.js";

const v = new HeuristicVision();
const svg = (body: string, w = 800, h = 600) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)).png().toBuffer();

describe("heuristic vision (offline fallback)", () => {
  it("detects a line-drawing floor plan without hints", async () => {
    const plan = await svg(`<rect width="100%" height="100%" fill="#fff"/><rect x="100" y="100" width="600" height="400" fill="none" stroke="#111" stroke-width="12"/><line x1="400" y1="100" x2="400" y2="500" stroke="#111" stroke-width="6"/>`);
    expect((await v.classify({ data: plan })).class).toBe("floorplan");
  });
  it("uses file names / alt text", async () => {
    const photo = await svg(`<rect width="100%" height="100%" fill="#a07850"/><circle cx="400" cy="300" r="120" fill="#335"/>`);
    expect(await v.classify({ data: photo, hint: "master-bedroom-02.jpg" })).toMatchObject({ class: "interior", roomType: "bedroom" });
    expect((await v.classify({ data: photo, hint: "pool-terrace.jpg" })).amenity).toBe("pool");
    expect((await v.classify({ data: photo, hint: "ground-floor-plan.png" })).levelHint).toBe("Ground floor");
  });
  it("sees sky in exterior shots", async () => {
    const ext = await svg(`<rect width="100%" height="50%" fill="#6fa8ff"/><rect y="50%" width="100%" height="50%" fill="#c8b89a"/>`);
    expect((await v.classify({ data: ext })).class).toBe("exterior");
  });
  it("extracts floor and wall colours", async () => {
    const room = await svg(`<rect width="100%" height="100%" fill="#f0ece4"/><rect y="75%" width="100%" height="25%" fill="#a0703c"/>`);
    const m = await v.materials({ data: room });
    expect(m.floor.kind).toBe("wood");
    // sharp bins the dominant colour, so compare approximately
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [r, g, b] = rgb(m.wallColorHex);
    expect(Math.abs(r - 0xf0) + Math.abs(g - 0xec) + Math.abs(b - 0xe4)).toBeLessThan(30);
  });
});
