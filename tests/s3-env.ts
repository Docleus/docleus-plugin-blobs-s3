import { randomUUID } from "node:crypto";
import { createS3Client, type S3Client } from "../src/server/s3-client.ts";
import { sha256Hex, signRequest } from "../src/server/sigv4.ts";

/** A real S3-compatible store, configured through `DOCLEUS_TEST_S3_*`. */
export interface TestS3 {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
}

function readTestS3(): TestS3 | undefined {
  const env = process.env;
  const endpoint = env.DOCLEUS_TEST_S3_ENDPOINT;
  const accessKeyId = env.DOCLEUS_TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = env.DOCLEUS_TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) return undefined;
  return {
    endpoint,
    region: env.DOCLEUS_TEST_S3_REGION || "us-east-1",
    bucket: env.DOCLEUS_TEST_S3_BUCKET || "docleus-test",
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.DOCLEUS_TEST_S3_FORCE_PATH_STYLE !== "false",
  };
}

/** Undefined without `DOCLEUS_TEST_S3_ENDPOINT` and credentials; tests that need it skip. */
export const TEST_S3 = readTestS3();

/** A fresh key prefix per test run so runs do not see each other's objects. */
export function uniquePrefix(): string {
  return `test-${randomUUID()}/`;
}

export function testClient(s3: TestS3): S3Client {
  return createS3Client({
    endpoint: new URL(s3.endpoint),
    region: s3.region,
    bucket: s3.bucket,
    credentials: s3,
    forcePathStyle: s3.forcePathStyle,
    requestTimeoutMs: 10_000,
  });
}

/** Creates the bucket unless it exists (`BucketAlreadyOwnedByYou` is fine). */
export async function ensureBucket(s3: TestS3): Promise<void> {
  const base = s3.endpoint.replace(/\/+$/, "");
  const url = s3.forcePathStyle
    ? new URL(`${base}/${s3.bucket}`)
    : new URL(base.replace("://", `://${s3.bucket}.`));
  const payloadHash = sha256Hex("");
  const signed = signRequest({
    method: "PUT",
    url,
    headers: [["x-amz-content-sha256", payloadHash]],
    payloadHash,
    credentials: s3,
    region: s3.region,
    service: "s3",
    date: new Date(),
  });
  const response = await fetch(url, { method: "PUT", headers: signed.headers });
  const text = await response.text();
  if (
    !response.ok &&
    !/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(text)
  ) {
    throw new Error(`creating bucket ${s3.bucket}: ${response.status} ${text}`);
  }
}
