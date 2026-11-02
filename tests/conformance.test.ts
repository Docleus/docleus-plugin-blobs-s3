import {
  blobsConformanceSuite,
  runConformanceSuite,
} from "@docleus/conformance";
import type { BlobsService } from "@docleus/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3BlobsService } from "../src/server/blobs.ts";
import { createS3Client } from "../src/server/s3-client.ts";
import { createFakeS3, FAKE_S3 } from "./fake-s3.ts";
import {
  ensureBucket,
  TEST_S3,
  testClient,
  uniquePrefix,
  type TestS3,
} from "./s3-env.ts";

describe("against the in-process fake S3", () => {
  runConformanceSuite(blobsConformanceSuite, () =>
    createS3BlobsService({
      client: createS3Client({
        ...FAKE_S3,
        forcePathStyle: true,
        requestTimeoutMs: 5_000,
        fetch: createFakeS3().fetch,
      }),
      prefix: "conformance/",
    }),
  );
});

interface Tracked {
  readonly blobs: BlobsService;
  readonly hashes: Set<string>;
}

// Each subject gets its own prefix and deletes what it stored, so runs
// against a shared bucket neither interfere nor leave objects behind.
function trackedService(s3: TestS3): Tracked {
  const blobs = createS3BlobsService({
    client: testClient(s3),
    prefix: uniquePrefix(),
  });
  const hashes = new Set<string>();
  return {
    hashes,
    blobs: {
      ...blobs,
      async put(data) {
        const stat = await blobs.put(data);
        hashes.add(stat.hash);
        return stat;
      },
    },
  };
}

describe.skipIf(!TEST_S3)("against DOCLEUS_TEST_S3_ENDPOINT", () => {
  const s3 = TEST_S3 as TestS3;
  beforeAll(() => ensureBucket(s3));

  const subjects = new Map<BlobsService, Tracked>();
  runConformanceSuite(
    blobsConformanceSuite,
    () => {
      const tracked = trackedService(s3);
      subjects.set(tracked.blobs, tracked);
      return tracked.blobs;
    },
    async (blobs) => {
      const tracked = subjects.get(blobs);
      subjects.delete(blobs);
      for (const hash of tracked?.hashes ?? []) await blobs.delete(hash);
    },
  );

  it("is rejected by the store when the secret key is wrong", async () => {
    const blobs = createS3BlobsService({
      client: testClient({ ...s3, secretAccessKey: "not-the-secret-key" }),
      prefix: uniquePrefix(),
    });
    await expect(blobs.stat("0".repeat(64))).rejects.toMatchObject({
      code: "blobs-s3/request-failed",
    });
    await expect(blobs.get("0".repeat(64))).rejects.toMatchObject({
      message: expect.stringMatching(/403 SignatureDoesNotMatch$/),
    });
  });

  it("stores and lists keys with characters that need encoding in the prefix", async () => {
    const blobs = createS3BlobsService({
      client: testClient(s3),
      prefix: `${uniquePrefix()}a b+c$d/`,
    });
    const { hash } = await blobs.put(new TextEncoder().encode("encoded"));
    expect(await blobs.stat(hash)).toEqual({ hash, size: 7 });
    const listed = [];
    for await (const entry of blobs.list?.() ?? []) listed.push(entry.hash);
    expect(listed).toEqual([hash]);
    expect(await blobs.delete(hash)).toBe(true);
  });
});
