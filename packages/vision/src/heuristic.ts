import type { RoomType } from "@pv/shared";
import { dominantColor, imageStats } from "./prepare.js";
import type { ClassificationOut, FloorplanSemantics, MaterialsOut, RoomMatch, VisionImage, VisionProvider } from "./types.js";

const ROOM_WORDS: [RoomType, RegExp][] = [
  ["kitchen", /kitchen|kök|cocina|cuisine/i],
  ["bathroom", /bath|badrum|baño|bano|shower|ensuite/i],
  ["bedroom", /bed(room)?|sovrum|dormitorio|chambre|master/i],
  ["living", /living|lounge|vardagsrum|salon|sal[oó]n/i],
  ["dining", /dining|matsal|comedor/i],
  ["terrace", /terrace|terrass|terraza|patio|veranda/i],
  ["balcony", /balcon|balkong/i],
  ["office", /office|study|kontor/i],
  ["hall", /hall|entrance|entry|corridor|recibidor/i],
  ["garage", /garage|garaje/i],
  ["laundry", /laundry|tvätt|lavander/i],
];

/**
 * Offline fallback provider: no API key needed. Uses filename/alt keywords plus simple
 * image statistics. Accuracy is modest; results are flagged with low confidence so the
 * admin review screen highlights them.
 */
export class HeuristicVision implements VisionProvider {
  readonly name = "heuristic";

  async classify(img: VisionImage): Promise<ClassificationOut> {
    const hint = img.hint ?? "";
    const st = await imageStats(img.data);
    const kw = (re: RegExp) => re.test(hint);
    if (kw(/floor[-_ ]?plan|plano|planritning|layout|plan[-_.]/i) || (st.white > 0.55 && st.saturation < 0.12 && st.greyLevels < 0.7))
      return {
        class: "floorplan",
        roomType: null,
        amenity: null,
        confidence: kw(/plan/i) ? 0.75 : 0.55,
        caption: "Floor plan",
        levelHint: /ground|planta baja|bottenv/i.test(hint) ? "Ground floor" : /first|upper|planta 1|övervåning/i.test(hint) ? "First floor" : null,
      };
    if (kw(/pool|piscina/i)) return { class: "amenity", roomType: null, amenity: "pool", confidence: 0.6, caption: "Swimming pool", levelHint: null };
    if (kw(/gym|fitness/i)) return { class: "amenity", roomType: null, amenity: "gym", confidence: 0.6, caption: "Gym", levelHint: null };
    if (kw(/rooftop|solarium/i)) return { class: "amenity", roomType: null, amenity: "rooftop", confidence: 0.6, caption: "Rooftop terrace", levelHint: null };
    if (kw(/view|vista|utsikt|sea-?view/i)) return { class: "view", roomType: null, amenity: null, confidence: 0.55, caption: "View from the property", levelHint: null };
    for (const [type, re] of ROOM_WORDS)
      if (re.test(hint)) return { class: "interior", roomType: type, amenity: null, confidence: 0.6, caption: `${type} photo`, levelHint: null };
    if (kw(/facade|fachada|exterior|outside|front|villa|building/i) || st.skyTop > 0.35)
      return { class: "exterior", roomType: null, amenity: null, confidence: kw(/exterior|facade|fachada/i) ? 0.6 : 0.4, caption: "Exterior of the building", levelHint: null };
    return { class: "interior", roomType: "other", amenity: null, confidence: 0.3, caption: "Interior photo", levelHint: null };
  }

  async analyzeFloorplan(img: VisionImage): Promise<FloorplanSemantics> {
    // No semantic reading offline: CV does geometry, rooms get size-based names.
    const levelIndex = /ground|planta baja|bottenv|level[-_ ]?0/i.test(img.hint ?? "")
      ? 0
      : /first|upper|planta 1|övervåning|level[-_ ]?1/i.test(img.hint ?? "")
        ? 1
        : null;
    return { isFloorplan: true, levelHint: null, levelIndex, totalAreaM2: null, ceilingHeightM: null, multiUnit: false, rooms: [] };
  }

  async matchRoom(img: VisionImage, rooms: { id: string; name: string; type: string }[]): Promise<RoomMatch> {
    const c = await this.classify(img);
    const r = rooms.find((x) => x.type === c.roomType);
    return { roomId: r?.id ?? null, confidence: r ? 0.4 : 0, reason: r ? `room type ${c.roomType} from filename/alt text` : "no match" };
  }

  async materials(img: VisionImage): Promise<MaterialsOut> {
    const floor = await dominantColor(img.data, "bottom");
    const wall = await dominantColor(img.data, "middle");
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(floor.slice(i, i + 2), 16));
    const warm = r > b + 25 && g > b;
    return {
      floor: { kind: warm ? "wood" : r > 200 && g > 200 && b > 200 ? "tile" : "stone", colorHex: floor },
      wallColorHex: wall,
      style: "contemporary",
    };
  }
}
