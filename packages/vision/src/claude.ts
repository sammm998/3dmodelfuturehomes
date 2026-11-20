import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { prepareImage } from "./prepare.js";
import { CLASSIFY_PROMPT, FLOORPLAN_PROMPT, MATCH_PROMPT, MATERIALS_PROMPT } from "./prompts.js";
import {
  ClassificationOut,
  FloorplanSemantics,
  MaterialsOut,
  RoomMatch,
  type VisionImage,
  type VisionProvider,
} from "./types.js";

type Effort = "low" | "medium" | "high";

/**
 * Claude vision provider. Uses structured outputs (Zod) so every response is schema-valid,
 * and server-side refusal fallbacks so a declined request is retried on a fallback model.
 */
export class ClaudeVision implements VisionProvider {
  readonly name = "claude";
  private client: Anthropic;
  constructor(
    private model = process.env.CLAUDE_VISION_MODEL || "claude-opus-5-5",
    apiKey?: string,
  ) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  private async ask<T extends z.ZodType>(img: VisionImage, prompt: string, schema: T, effort: Effort): Promise<z.infer<T>> {
    const { b64, mime } = await prepareImage(img.data);
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort, format: betaZodOutputFormat(schema) },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
            { type: "text", text: prompt + (img.hint ? `\n\nFile name / alt text (may help): ${img.hint.slice(0, 300)}` : "") },
          ],
        },
      ],
    });
    if (res.stop_reason === "refusal") throw new Error("vision request refused");
    if (!res.parsed_output) throw new Error(`vision response could not be parsed (stop_reason=${res.stop_reason})`);
    return res.parsed_output as z.infer<T>;
  }

  classify(img: VisionImage) {
    return this.ask(img, CLASSIFY_PROMPT, ClassificationOut, "low");
  }
  analyzeFloorplan(img: VisionImage) {
    return this.ask(img, FLOORPLAN_PROMPT, FloorplanSemantics, "medium");
  }
  matchRoom(img: VisionImage, rooms: { id: string; name: string; type: string }[]) {
    return this.ask(img, MATCH_PROMPT(rooms), RoomMatch, "low");
  }
  materials(img: VisionImage) {
    return this.ask(img, MATERIALS_PROMPT, MaterialsOut, "low");
  }
}
