import { ensureBucket, migrate } from "@pv/server";
import { buildApp } from "./app.js";

async function main() {
  const applied = await migrate();
  if (applied.length) console.log("migrations applied:", applied.join(", "));
  await ensureBucket();
  const app = await buildApp();
  // "::" = dual-stack (IPv4 + IPv6): required for private networks such as Railway's
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? "::" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
