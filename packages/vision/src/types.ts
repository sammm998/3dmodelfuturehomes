import { z } from "zod";
import { AmenityType, ImageClass, RoomType } from "@pv/shared";

export const ClassificationOut = z.object({
  class: ImageClass,
  roomType: RoomType.nullable(),
  amenity: AmenityType.nullable(),
  confidence: z.number(),
  caption: z.string(),
  levelHint: z.string().nullable(),
});
export type ClassificationOut = z.infer<typeof ClassificationOut>;

export const FloorplanSemantics = z.object({
  isFloorplan: z.boolean(),
  /** e.g. "Ground floor"; null if unknown */
  levelHint: z.string().nullable(),
  /** 0 = ground, 1 = first upper floor, -1 = basement */
  levelIndex: z.number().nullable(),
  /** total area printed on the plan, if any */
  totalAreaM2: z.number().nullable(),
  ceilingHeightM: z.number().nullable(),
  /** true if the image shows several separate apartments/units */
  multiUnit: z.boolean(),
  rooms: z.array(
    z.object({
      name: z.string(),
      type: RoomType,
      /** approximate centre of the room label, normalised 0..1 (x right, y down) */
      cx: z.number(),
      cy: z.number(),
      areaM2: z.number().nullable(),
      /** printed dimensions such as "4.20 x 3.50" converted to metres */
      widthM: z.number().nullable(),
      depthM: z.number().nullable(),
    }),
  ),
});
export type FloorplanSemantics = z.infer<typeof FloorplanSemantics>;

export const RoomMatch = z.object({
  roomId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});
export type RoomMatch = z.infer<typeof RoomMatch>;

export const MaterialsOut = z.object({
  floor: z.object({
    kind: z.enum(["wood", "tile", "stone", "concrete", "carpet", "unknown"]),
    colorHex: z.string(),
  }),
  wallColorHex: z.string(),
  style: z.string(),
});
export type MaterialsOut = z.infer<typeof MaterialsOut>;

export interface VisionImage {
  data: Buffer;
  /** filename / url / alt text: gives the heuristic provider something to work with */
  hint?: string;
}

export interface VisionProvider {
  readonly name: string;
  classify(img: VisionImage): Promise<ClassificationOut>;
  analyzeFloorplan(img: VisionImage): Promise<FloorplanSemantics>;
  matchRoom(img: VisionImage, rooms: { id: string; name: string; type: string }[]): Promise<RoomMatch>;
  materials(img: VisionImage): Promise<MaterialsOut>;
}
