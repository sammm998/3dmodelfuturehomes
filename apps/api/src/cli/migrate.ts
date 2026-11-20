import { migrate, pool } from "@pv/server";

const applied = await migrate();
console.log(applied.length ? `applied: ${applied.join(", ")}` : "database up to date");
await pool.end();
