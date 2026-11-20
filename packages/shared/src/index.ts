export * from "./schemas.js";
export * from "./geometry.js";
export * from "./planBuilder.js";
export * from "./generator.js";
export * from "./furniture.js";
export * from "./provenance.js";
export * from "./demo.js";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "property";
