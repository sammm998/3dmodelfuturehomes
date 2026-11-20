import { PIPELINE_STEPS, type JobStep, type JobStepStatus } from "@pv/shared";
import type { Redis } from "ioredis";
import { one, q } from "./db.js";
import { connection, jobChannel } from "./queue.js";

let pub: Redis | null = null;
const publisher = () => (pub ??= connection());

export function initialSteps(skip: string[] = []): JobStep[] {
  return PIPELINE_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    status: skip.includes(s.key) ? "skipped" : "pending",
    message: null,
    startedAt: null,
    finishedAt: null,
  }));
}

export async function createJob(propertyId: string | null, type: string, input: unknown, steps: JobStep[]) {
  return one<{ id: string }>(
    "insert into jobs(property_id, type, input, steps) values ($1,$2,$3,$4) returning id",
    [propertyId, type, JSON.stringify(input), JSON.stringify(steps)],
  );
}

async function publish(jobId: string) {
  const job = await one("select id, property_id, status, steps, error from jobs where id=$1", [jobId]);
  if (job) await publisher().publish(jobChannel(jobId), JSON.stringify(job));
}

export async function setStep(jobId: string, key: string, status: JobStepStatus, message: string | null = null) {
  const now = new Date().toISOString();
  await q(
    `update jobs set status = case when status='queued' then 'running' else status end,
       started_at = coalesce(started_at, now()),
       steps = (
         select jsonb_agg(
           case when s->>'key' = $2 then s
             || jsonb_build_object('status', $3::text, 'message', $4::text)
             || case when $3 = 'running' then jsonb_build_object('startedAt', $5::text) else '{}'::jsonb end
             || case when $3 in ('done','skipped','failed') then jsonb_build_object('finishedAt', $5::text) else '{}'::jsonb end
           else s end order by ord)
         from jsonb_array_elements(steps) with ordinality as t(s, ord))
     where id = $1`,
    [jobId, key, status, message, now],
  );
  await publish(jobId);
}

export async function finishJob(jobId: string, status: "done" | "failed", error: string | null = null) {
  await q("update jobs set status=$2, error=$3, finished_at=now() where id=$1", [jobId, status, error]);
  await publish(jobId);
}
