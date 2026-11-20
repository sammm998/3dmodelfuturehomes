import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

// Request validation and routing that need no database.
describe("api", async () => {
  const app = await buildApp();
  afterAll(() => app.close());

  it("health", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.json()).toEqual({ ok: true });
  });
  it("rejects an invalid import url", async () => {
    const r = await app.inject({ method: "POST", url: "/api/imports", payload: { url: "not a url" } });
    expect(r.statusCode).toBe(400);
  });
  it("rejects malformed analytics events", async () => {
    const r = await app.inject({ method: "POST", url: "/api/p/x/events", payload: { sessionId: "1", type: "nope" } });
    expect(r.statusCode).toBe(400);
  });
  it("does not serve arbitrary object keys", async () => {
    const r = await app.inject({ method: "GET", url: "/files/secrets/key.txt" });
    expect(r.statusCode).toBe(404);
  });
});
