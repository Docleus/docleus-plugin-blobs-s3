import { createHash, createHmac } from "node:crypto";
import { BLOB_PUT_REFRESH_MS, type BlobEntry } from "@docleus/sdk";
import { describe, expect, it } from "vitest";
import { createFakeS3, FAKE_S3 } from "../../tests/fake-s3.ts";
import { createS3BlobsService } from "./blobs.ts";
import { createS3Client } from "./s3-client.ts";

const bytes = (value: string) => new TextEncoder().encode(value);
const HELLO =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const hashOf = (value: string) =>
  createHash("sha256").update(value).digest("hex");

async function listed(blobs: {
  list?(): AsyncIterable<BlobEntry>;
}): Promise<BlobEntry[]> {
  const entries: BlobEntry[] = [];
  for await (const entry of blobs.list?.() ?? []) entries.push(entry);
  return entries.toSorted((a, b) => (a.hash < b.hash ? -1 : 1));
}

function setup(prefix = "", signingSecret?: Uint8Array, pageSize?: number) {
  const s3 = createFakeS3({ pageSize });
  const client = createS3Client({
    ...FAKE_S3,
    forcePathStyle: true,
    requestTimeoutMs: 5_000,
    fetch: s3.fetch,
  });
  return { s3, blobs: createS3BlobsService({ client, prefix, signingSecret }) };
}

describe("createS3BlobsService", () => {
  it("stores content-addressed objects sharded under the prefix", async () => {
    const { s3, blobs } = setup("docleus/blobs/");
    await blobs.put(bytes("hello"));
    expect([...s3.objects.keys()]).toEqual([`docleus/blobs/2c/f2/${HELLO}`]);
  });

  it("skips the upload when the object already exists", async () => {
    const { s3, blobs } = setup();
    await blobs.put(bytes("hello"));
    await blobs.put(bytes("hello"));
    expect(s3.requests.map((request) => request.method)).toEqual([
      "HEAD",
      "PUT",
      "HEAD",
    ]);
  });

  it("uploads an existing object again once it is older than the refresh window", async () => {
    const { s3, blobs } = setup();
    await blobs.put(bytes("hello"));
    const key = `2c/f2/${HELLO}`;
    s3.modified.set(key, new Date(Date.now() - BLOB_PUT_REFRESH_MS - 1000));
    s3.requests.length = 0;

    await blobs.put(bytes("hello"));
    expect(s3.requests.map((request) => request.method)).toEqual([
      "HEAD",
      "PUT",
    ]);
    expect(Date.now() - (s3.modified.get(key)?.getTime() ?? 0)).toBeLessThan(
      BLOB_PUT_REFRESH_MS,
    );
  });

  it("lists every blob under the prefix across pages", async () => {
    const { s3, blobs } = setup("p/", undefined, 2);
    const texts = ["one", "two", "three", "four", "five"];
    for (const text of texts) await blobs.put(bytes(text));

    const entries = await listed(blobs);
    expect(entries.map((entry) => entry.hash)).toEqual(
      texts.map(hashOf).toSorted(),
    );
    const three = entries.find((entry) => entry.hash === hashOf("three"));
    expect(three).toEqual({
      hash: hashOf("three"),
      size: 5,
      storedAt: s3.modified
        .get(
          `p/${hashOf("three").slice(0, 2)}/${hashOf("three").slice(2, 4)}/${hashOf("three")}`,
        )
        ?.getTime(),
    });
    expect(
      s3.requests.filter((request) => request.url.search !== "").length,
    ).toBe(3);
  });

  it("leaves out objects that are not blobs of this prefix", async () => {
    const { s3, blobs } = setup("p/");
    const { hash } = await blobs.put(bytes("mine"));
    const foreign = [
      "p/readme.txt",
      `p/other/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hashOf("nested")}`,
      `p/00/00/${hashOf("misplaced")}`,
      `p/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.tmp`,
      `q/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
    ];
    for (const key of foreign) s3.objects.set(key, bytes("x"));

    expect((await listed(blobs)).map((entry) => entry.hash)).toEqual([hash]);
  });

  it("does not send DELETE for a blob that is not there", async () => {
    const { s3, blobs } = setup();
    expect(await blobs.delete("0".repeat(64))).toBe(false);
    expect(s3.requests.map((request) => request.method)).toEqual(["HEAD"]);
  });

  it.each(["get", "stat", "delete"] as const)(
    "%s rejects a malformed hash before any request",
    async (method) => {
      const { s3, blobs } = setup();
      await expect(blobs[method]("../etc/passwd")).rejects.toMatchObject({
        code: "blobs/invalid-hash",
      });
      expect(s3.requests).toEqual([]);
    },
  );

  it("issues tokens in the core-blobs format", () => {
    const secret = Buffer.alloc(32, 7);
    const { blobs } = setup("", secret);
    const payload = `${HELLO}.1700000000000`;
    expect(blobs.sign(HELLO, 1_700_000_000_000)).toBe(
      `${payload}.${createHmac("sha256", secret).update(payload).digest("hex")}`,
    );
  });

  it("verifies tokens across instances that share the signing secret", () => {
    const secret = Buffer.alloc(32, 7);
    const token = setup("", secret).blobs.sign(HELLO, Date.now() + 60_000);
    expect(setup("", secret).blobs.verify(token)).toBe(HELLO);
    expect(setup().blobs.verify(token)).toBeUndefined();
  });

  it("rejects tokens for malformed hashes", () => {
    const { blobs } = setup();
    expect(() => blobs.sign("nope", Date.now())).toThrow(
      expect.objectContaining({ code: "blobs/invalid-hash" }),
    );
    expect(blobs.verify("nope.1.2")).toBeUndefined();
    expect(blobs.verify("nope")).toBeUndefined();
  });
});
