import { ensureBucket, migrate } from "@pv/server";
import { buildApp } from "./app.js";

async function main() {
  const applied = await migrate();
  if (applied.length) console.log("migrations applied:", applied.join(", "));
  await ensureBucket();
  const app = await buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: "0.0.0.0" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
