import sharp from "sharp";

/** Downscale to <= maxSide px JPEG for vision APIs (keeps tokens and latency down). */
export async function prepareImage(data: Buffer, maxSide = 1568): Promise<{ b64: string; mime: "image/jpeg" }> {
  const out = await sharp(data, { failOn: "none" })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { b64: out.toString("base64"), mime: "image/jpeg" };
}

export interface ImageStats {
  width: number;
  height: number;
  /** share of near-white pixels */
  white: number;
  /** mean saturation 0..1 */
  saturation: number;
  /** share of sky-blue pixels in top third */
  skyTop: number;
  /** share of strong edges (line drawing indicator) */
  edgeDensity: number;
  /** share of distinct grey levels used: plans use few */
  greyLevels: number;
}

export async function imageStats(data: Buffer): Promise<ImageStats> {
  const meta = await sharp(data, { failOn: "none" }).metadata();
  const S = 128;
  const { data: px } = await sharp(data, { failOn: "none" })
    .rotate()
    .resize(S, S, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let white = 0,
    sat = 0,
    sky = 0,
    edges = 0;
  const greys = new Set<number>();
  const lum = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    const r = px[i * 3],
      g = px[i * 3 + 1],
      b = px[i * 3 + 2];
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    const s = mx === 0 ? 0 : (mx - mn) / mx;
    sat += s;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (mn > 225) white++;
    greys.add(Math.round(lum[i] / 8));
    const y = Math.floor(i / S);
    if (y < S / 3 && b > 150 && b > r + 15 && b >= g) sky++;
  }
  for (let y = 1; y < S - 1; y++)
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const gx = lum[i + 1] - lum[i - 1];
      const gy = lum[i + S] - lum[i - S];
      if (Math.hypot(gx, gy) > 120) edges++;
    }
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    white: white / (S * S),
    saturation: sat / (S * S),
    skyTop: sky / ((S * S) / 3),
    edgeDensity: edges / (S * S),
    greyLevels: greys.size / 32,
  };
}

export async function dominantColor(data: Buffer, region: "bottom" | "middle" | "all" = "all"): Promise<string> {
  const img = sharp(data, { failOn: "none" }).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? 1,
    h = meta.height ?? 1;
  const top = region === "bottom" ? Math.floor(h * 0.72) : region === "middle" ? Math.floor(h * 0.25) : 0;
  const height = region === "bottom" ? h - top : region === "middle" ? Math.floor(h * 0.3) : h;
  const { dominant } = await sharp(data, { failOn: "none" })
    .rotate()
    .extract({ left: 0, top, width: w, height: Math.max(1, height) })
    .stats();
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}`;
}
