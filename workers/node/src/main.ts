import { Worker } from "bullmq";
import { connection, ensureBucket, migrate, QUEUE_PIPELINE } from "@pv/server";
import { closeBrowser } from "./scrape/browser.js";
import { runPipeline, type PipelineJob } from "./pipeline/run.js";

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
