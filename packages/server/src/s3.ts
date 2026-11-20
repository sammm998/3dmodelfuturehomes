import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import { env } from "./env.js";

export const s3 = new S3Client({
  endpoint: env.s3.endpoint,
  region: env.s3.region,
  forcePathStyle: env.s3.forcePathStyle,
  credentials: { accessKeyId: env.s3.accessKey, secretAccessKey: env.s3.secretKey },
});

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.s3.bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: env.s3.bucket }));
  }
}

export async function putObject(key: string, body: Buffer | Uint8Array | string, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket: env.s3.bucket, Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function getObject(key: string): Promise<Buffer> {
  const r = await s3.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key }));
  const chunks: Buffer[] = [];
  for await (const c of r.Body as Readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

export async function getObjectStream(key: string, range?: string) {
  const r = await s3.send(new GetObjectCommand({ Bucket: env.s3.bucket, Key: key, Range: range }));
  return {
    body: r.Body as Readable,
    contentType: r.ContentType,
    contentLength: r.ContentLength,
    contentRange: r.ContentRange,
    etag: r.ETag,
  };
}

/** Public URL for an object, served through the API's /files proxy (works behind any S3). */
export const fileUrl = (key: string | null | undefined) =>
  key ? `${env.publicApiUrl}/files/${key.split("/").map(encodeURIComponent).join("/")}` : null;
