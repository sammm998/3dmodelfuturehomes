import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { env } from "./env.js";

export const connection = () => new Redis(env.redisUrl, { maxRetriesPerRequest: null });

export const QUEUE_PIPELINE = "pipeline"; // Node orchestrator
export const QUEUE_PY = "py"; // Python CV/3D worker

let _pipeline: Queue | null = null;
let _py: Queue | null = null;
let _pyEvents: QueueEvents | null = null;

export const pipelineQueue = () => (_pipeline ??= new Queue(QUEUE_PIPELINE, { connection: connection() }));
export const pyQueue = () => (_py ??= new Queue(QUEUE_PY, { connection: connection() }));
export const pyEvents = () => (_pyEvents ??= new QueueEvents(QUEUE_PY, { connection: connection() }));

/** Run a job on the Python worker and wait for its JSON result. */
export async function runPy<T = any>(name: string, data: Record<string, unknown>, timeoutMs = 30 * 60_000): Promise<T> {
  const ev = pyEvents();
  await ev.waitUntilReady();
  const job = await pyQueue().add(name, data, { removeOnComplete: 200, removeOnFail: 500, attempts: 1 });
  return (await job.waitUntilFinished(ev, timeoutMs)) as T;
}

/** pub/sub channel used to stream job progress to SSE clients */
export const jobChannel = (jobId: string) => `job:${jobId}`;
