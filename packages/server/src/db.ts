import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { env } from "./env.js";

// numeric -> number (prices/areas are well within double precision)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: env.databaseUrl, max: 10 });

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate(): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  await pool.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set((await q<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const done: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(f)) continue;
    await tx(async (c) => {
      await c.query(readFileSync(join(dir, f), "utf8"));
      await c.query("insert into schema_migrations(name) values ($1) on conflict do nothing", [f]);
    });
    done.push(f);
  }
  return done;
}
