import { Worker } from "bullmq";
import { connection, ensureBucket, migrate, QUEUE_PIPELINE } from "@pv/server";
import { closeBrowser } from "./scrape/browser.js";
import { runPipeline, type PipelineJob } from "./pipeline/run.js";
import { ClaudeVision } from "@pv/vision";
import sharp from "sharp";

/** Verify the vision model at startup so a bad key/model shows up in the logs, not as silent fallbacks. */
async function visionSelfTest() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[vision] ANTHROPIC_API_KEY not set: using the offline heuristic (facades will not be read from photos)");
    return;
  }
  try {
    const img = await sharp({ create: { width: 256, height: 192, channels: 3, background: "#6fa8ff" } })
      .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="192"><rect x="70" y="60" width="120" height="132" fill="#e8e0d0"/></svg>'), top: 0, left: 0 }])
      .png()
      .toBuffer();
    const t = Date.now();
    const r = await new ClaudeVision().classify({ data: img, hint: "building exterior" });
    console.log(`[vision] Claude OK (${process.env.CLAUDE_VISION_MODEL || "claude-opus-5-5"}, ${Date.now() - t} ms): ${r.class}`);
  } catch (e: any) {
    console.error(`[vision] Claude self-test FAILED: ${e?.status ?? ""} ${e?.message ?? e}`);
  }
}

async function main() {
  await migrate();
  await ensureBucket();
  const worker = new Worker<PipelineJob>(
    QUEUE_PIPELINE,
    async (job) => {
      console.log(`[pipeline] ${job.data.mode} property=${job.data.propertyId} job=${job.data.jobId}`);
      await runPipeline(job.data);
    },
    { connection: connection(), concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 2), lockDuration: 10 * 60_000 },
  );
  worker.on("failed", (j, e) => console.error("[pipeline] failed", j?.id, e));
  console.log("[worker] pipeline worker ready");
  void visionSelfTest();
  const stop = async () => {
    await worker.close();
    await closeBrowser();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
