import { describe, expect, it } from "vitest";
import { createFakeS3, FAKE_S3 } from "../../tests/fake-s3.ts";
import {
  createS3Client,
  objectUrl,
  type S3ClientOptions,
} from "./s3-client.ts";
import { sha256Hex } from "./sigv4.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

function clientOptions(
  overrides: Partial<S3ClientOptions> = {},
): S3ClientOptions {
  return {
    ...FAKE_S3,
    forcePathStyle: true,
    requestTimeoutMs: 5_000,
    ...overrides,
  };
}

describe("objectUrl", () => {
  it("puts the bucket in the path with forcePathStyle", () => {
    expect(objectUrl(clientOptions(), "p/ab/cd/x").href).toBe(
      "http://s3.test/docs/p/ab/cd/x",
    );
  });

  it("puts the bucket in the host name by default", () => {
    const options = clientOptions({
      endpoint: new URL("https://s3.eu-west-3.amazonaws.com"),
      forcePathStyle: false,
    });
    expect(objectUrl(options, "ab/cd/x").href).toBe(
      "https://docs.s3.eu-west-3.amazonaws.com/ab/cd/x",
    );
  });

  it("keeps the endpoint base path and encodes each key segment once", () => {
    const options = clientOptions({ endpoint: new URL("http://h:9000/s3") });
    expect(objectUrl(options, "a b/c$d").href).toBe(
      "http://h:9000/s3/docs/a%20b/c%24d",
    );
  });
});

describe("createS3Client", () => {
  it("signs the payload hash instead of UNSIGNED-PAYLOAD", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(clientOptions({ fetch: s3.fetch }));
    const body = bytes("payload");
    await client.putObject("k", body, sha256Hex(body));

    const [put] = s3.requests;
    expect(put?.headers["x-amz-content-sha256"]).toBe(sha256Hex(body));
    expect(put?.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=fake-access\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(s3.objects.get("k")).toEqual(body);
  });

  it("round-trips an object through PUT, HEAD, GET and DELETE", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(clientOptions({ fetch: s3.fetch }));
    const body = bytes("hello");
    await client.putObject("a/b", body, sha256Hex(body));
    expect(await client.headObject("a/b")).toEqual({
      size: 5,
      lastModified:
        Math.floor((s3.modified.get("a/b")?.getTime() ?? 0) / 1000) * 1000,
    });
    expect(await client.getObject("a/b")).toEqual(body);
    await client.deleteObject("a/b");
    expect(await client.headObject("a/b")).toBeUndefined();
    expect(await client.getObject("a/b")).toBeUndefined();
    expect(s3.requests.map((request) => request.method)).toEqual([
      "PUT",
      "HEAD",
      "GET",
      "DELETE",
      "HEAD",
      "GET",
    ]);
  });

  it("sends the session token when there is one", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(
      clientOptions({
        fetch: s3.fetch,
        credentials: { ...FAKE_S3.credentials, sessionToken: "token" },
      }),
    );
    await client.headObject("k");
    expect(s3.requests[0]?.headers["x-amz-security-token"]).toBe("token");
  });

  it("reports the S3 error code when the store rejects a request", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(
      clientOptions({
        fetch: s3.fetch,
        credentials: { accessKeyId: "fake-access", secretAccessKey: "wrong" },
      }),
    );
    await expect(client.getObject("k")).rejects.toMatchObject({
      code: "blobs-s3/request-failed",
      message: "GET docs/k: 403 SignatureDoesNotMatch",
    });
  });

  it("rejects a body that does not match the signed hash", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(clientOptions({ fetch: s3.fetch }));
    await expect(
      client.putObject("k", bytes("a"), sha256Hex("b")),
    ).rejects.toMatchObject({
      message: "PUT docs/k: 400 XAmzContentSHA256Mismatch",
    });
  });

  it("wraps network failures", async () => {
    const client = createS3Client(
      clientOptions({
        fetch: () => Promise.reject(new TypeError("fetch failed")),
      }),
    );
    await expect(client.headObject("k")).rejects.toMatchObject({
      code: "blobs-s3/request-failed",
      message: "HEAD http://s3.test/docs/k failed",
    });
  });

  it("rejects a HEAD response without a usable Content-Length", async () => {
    const client = createS3Client(
      clientOptions({
        fetch: () =>
          Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "content-length": "x" },
            }),
          ),
      }),
    );
    await expect(client.headObject("k")).rejects.toMatchObject({
      code: "blobs-s3/invalid-response",
    });
  });

  it("rejects a HEAD response without a usable Last-Modified", async () => {
    const client = createS3Client(
      clientOptions({
        fetch: () =>
          Promise.resolve(
            new Response(null, {
              status: 200,
              headers: { "content-length": "1", "last-modified": "soon" },
            }),
          ),
      }),
    );
    await expect(client.headObject("k")).rejects.toMatchObject({
      code: "blobs-s3/invalid-response",
    });
  });

  it("lists keys under a prefix page by page", async () => {
    const s3 = createFakeS3({ pageSize: 2 });
    const client = createS3Client(clientOptions({ fetch: s3.fetch }));
    for (const key of ["p q/1", "p q/2", "p q/3", "other/4"]) {
      await client.putObject(key, bytes(key), sha256Hex(bytes(key)));
    }
    s3.modified.set("p q/2", new Date("2026-01-02T03:04:05.678Z"));

    const first = await client.listObjects("p q/");
    expect(first.objects.map((object) => object.key)).toEqual([
      "p q/1",
      "p q/2",
    ]);
    expect(first.objects[1]).toEqual({
      key: "p q/2",
      size: 5,
      lastModified: Date.parse("2026-01-02T03:04:05.678Z"),
    });
    expect(first.nextContinuationToken).toBeDefined();
    const second = await client.listObjects(
      "p q/",
      first.nextContinuationToken,
    );
    expect(second).toEqual({
      objects: [expect.objectContaining({ key: "p q/3" })],
      nextContinuationToken: undefined,
    });
    expect(s3.requests.at(-1)?.url.search).toMatch(
      /^\?list-type=2&prefix=p%20q%2F&continuation-token=/,
    );
  });

  it("reads keys with XML entities in a listing", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(clientOptions({ fetch: s3.fetch }));
    const key = `a&b<c>"d'e`;
    await client.putObject(key, bytes("x"), sha256Hex(bytes("x")));
    const page = await client.listObjects("");
    expect(page.objects.map((object) => object.key)).toEqual([key]);
  });

  it("lists the bucket root of a virtual-hosted bucket", async () => {
    const urls: string[] = [];
    const client = createS3Client(
      clientOptions({
        endpoint: new URL("https://s3.eu-west-3.amazonaws.com"),
        forcePathStyle: false,
        fetch: (input) => {
          urls.push(String(input));
          return Promise.resolve(
            new Response(
              "<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>",
            ),
          );
        },
      }),
    );
    expect(await client.listObjects("a+b/")).toEqual({
      objects: [],
      nextContinuationToken: undefined,
    });
    expect(urls).toEqual([
      "https://docs.s3.eu-west-3.amazonaws.com/?list-type=2&prefix=a%2Bb%2F",
    ]);
  });

  it.each([
    ["not XML", "<html>oops</html>"],
    [
      "an object without a size",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>k</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents></ListBucketResult>",
    ],
    [
      "a bad timestamp",
      "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>k</Key><Size>1</Size><LastModified>yesterday</LastModified></Contents></ListBucketResult>",
    ],
    [
      "a truncated listing without a token",
      "<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>",
    ],
  ])("rejects a listing with %s", async (_, body) => {
    const client = createS3Client(
      clientOptions({ fetch: () => Promise.resolve(new Response(body)) }),
    );
    await expect(client.listObjects("")).rejects.toMatchObject({
      code: "blobs-s3/invalid-response",
    });
  });

  it("reports the S3 error code when a listing is refused", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(
      clientOptions({
        fetch: s3.fetch,
        credentials: { accessKeyId: "fake-access", secretAccessKey: "wrong" },
      }),
    );
    await expect(client.listObjects("p/")).rejects.toMatchObject({
      code: "blobs-s3/request-failed",
      message: "GET docs/?prefix=p/: 403 SignatureDoesNotMatch",
    });
  });

  it("signs with the clock it is given", async () => {
    const s3 = createFakeS3();
    const client = createS3Client(
      clientOptions({
        fetch: s3.fetch,
        now: () => new Date("2026-01-02T03:04:05Z"),
      }),
    );
    await client.headObject("k");
    expect(s3.requests[0]?.headers["x-amz-date"]).toBe("20260102T030405Z");
  });
});
