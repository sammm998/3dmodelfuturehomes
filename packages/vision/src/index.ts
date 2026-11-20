import { ClaudeVision } from "./claude.js";
import { HeuristicVision } from "./heuristic.js";
import { OpenAIVision } from "./openai.js";
import type { VisionImage, VisionProvider } from "./types.js";

export * from "./types.js";
export { ClaudeVision, HeuristicVision, OpenAIVision };
export { imageStats, prepareImage, dominantColor } from "./prepare.js";

/**
 * Wraps a remote provider: on any API failure it logs and falls back to the heuristic provider,
 * so an import never dies because of a vision API hiccup. `degraded` records that it happened.
 */
export class ResilientVision implements VisionProvider {
  readonly name: string;
  degraded = 0;
  private fallback = new HeuristicVision();
  constructor(private primary: VisionProvider) {
    this.name = primary.name;
  }
  private async run<T>(fn: (p: VisionProvider) => Promise<T>): Promise<T> {
    if (this.primary.name === "heuristic") return fn(this.primary);
    try {
      return await fn(this.primary);
    } catch (e) {
      this.degraded++;
      console.warn(`[vision:${this.primary.name}] failed, using heuristic fallback:`, (e as Error).message);
      return fn(this.fallback);
    }
  }
  classify(img: VisionImage) {
    return this.run((p) => p.classify(img));
  }
  analyzeFloorplan(img: VisionImage) {
    return this.run((p) => p.analyzeFloorplan(img));
  }
  matchRoom(img: VisionImage, rooms: { id: string; name: string; type: string }[]) {
    return this.run((p) => p.matchRoom(img, rooms));
  }
  materials(img: VisionImage) {
    return this.run((p) => p.materials(img));
  }
  exteriorSpec(imgs: VisionImage[]) {
    return this.run((p) => p.exteriorSpec(imgs));
  }
  facadeQuads(imgs: VisionImage[]) {
    return this.run((p) => p.facadeQuads(imgs));
  }
}

/** VISION_PROVIDER = anthropic | openai | heuristic | auto (default). */
export function createVisionProvider(): ResilientVision {
  const pref = (process.env.VISION_PROVIDER || "auto").toLowerCase();
  let p: VisionProvider;
  if (pref === "anthropic" || (pref === "auto" && process.env.ANTHROPIC_API_KEY)) p = new ClaudeVision();
  else if (pref === "openai" || (pref === "auto" && process.env.OPENAI_API_KEY)) p = new OpenAIVision();
  else p = new HeuristicVision();
  return new ResilientVision(p);
}
