import { ensureBucket, migrate } from "@pv/server";
import { buildApp } from "./app.js";

async function main() {
  const applied = await migrate();
  if (applied.length) console.log("migrations applied:", applied.join(", "));
  await ensureBucket();
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 4000);
  // "::" = dual-stack (IPv4 + IPv6): required for private networks such as Railway's.
  // Hosts without IPv6 support (EAFNOSUPPORT) fall back to IPv4.
  try {
    await app.listen({ port, host: process.env.HOST ?? "::" });
  } catch (e: any) {
    if (e?.code !== "EAFNOSUPPORT" && e?.errno !== -97) throw e;
    await app.listen({ port, host: "0.0.0.0" });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
