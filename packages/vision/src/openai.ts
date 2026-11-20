import OpenAI from "openai";
import { z } from "zod";
import { prepareImage } from "./prepare.js";
import { CLASSIFY_PROMPT, EXTERIOR_PROMPT, FLOORPLAN_PROMPT, MATCH_PROMPT, MATERIALS_PROMPT, FACADE_QUADS_PROMPT } from "./prompts.js";
import { FacadeQuads, FacadeSpec as ExteriorSpec } from "@pv/shared";
import {
  ClassificationOut,
  FloorplanSemantics,
  MaterialsOut,
  RoomMatch,
  type VisionImage,
  type VisionProvider,
} from "./types.js";

/** Make a JSON schema acceptable for OpenAI strict mode (all keys required, no extra keys). */
function strictify(s: any): any {
  if (Array.isArray(s)) return s.map(strictify);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) if (k !== "$schema") out[k] = strictify(v);
  if (out.type === "object" && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}

/** OpenAI fallback vision provider (same interface, same schemas). */
export class OpenAIVision implements VisionProvider {
  readonly name = "openai";
  private client: OpenAI;
  constructor(private model = process.env.OPENAI_VISION_MODEL || "gpt-4.1") {
    this.client = new OpenAI();
  }

  private async ask<T extends z.ZodType>(img: VisionImage | VisionImage[], prompt: string, schema: T, name: string): Promise<z.infer<T>> {
    const imgs = Array.isArray(img) ? img : [img];
    const parts = await Promise.all(
      imgs.map(async (im) => {
        const { b64, mime } = await prepareImage(im.data);
        return { type: "image_url" as const, image_url: { url: `data:${mime};base64,${b64}` } };
      }),
    );
    const hints = imgs.map((i) => i.hint).filter(Boolean).join(" | ");
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt + (hints ? `\n\nFile names / alt text: ${hints.slice(0, 500)}` : "") },
            ...parts,
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name, strict: true, schema: strictify(z.toJSONSchema(schema)) },
      },
    });
    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error("empty OpenAI response");
    return schema.parse(JSON.parse(text));
  }

  classify(img: VisionImage) {
    return this.ask(img, CLASSIFY_PROMPT, ClassificationOut, "classification");
  }
  analyzeFloorplan(img: VisionImage) {
    return this.ask(img, FLOORPLAN_PROMPT, FloorplanSemantics, "floorplan");
  }
  matchRoom(img: VisionImage, rooms: { id: string; name: string; type: string }[]) {
    return this.ask(img, MATCH_PROMPT(rooms), RoomMatch, "room_match");
  }
  materials(img: VisionImage) {
    return this.ask(img, MATERIALS_PROMPT, MaterialsOut, "materials");
  }
  exteriorSpec(imgs: VisionImage[]) {
    return this.ask(imgs.slice(0, 4), EXTERIOR_PROMPT, ExteriorSpec, "exterior");
  }
  facadeQuads(imgs: VisionImage[]) {
    return this.ask(imgs.slice(0, 6), FACADE_QUADS_PROMPT, FacadeQuads, "facade_quads");
  }
}
