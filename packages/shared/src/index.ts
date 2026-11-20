export * from "./schemas";
export * from "./geometry";
export * from "./planBuilder";
export * from "./generator";
export * from "./furniture";
export * from "./provenance";
export * from "./demo";

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "property";
