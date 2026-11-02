import { sha256Hex, signRequest } from "../src/server/sigv4.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
}

export interface FakeS3 {
  readonly fetch: typeof fetch;
  readonly objects: Map<string, Uint8Array>;
  /** When each object was last written; set an entry to age an object. */
  readonly modified: Map<string, Date>;
  readonly requests: RecordedRequest[];
}

export interface FakeS3Options {
  /** Keys per `ListObjectsV2` page; S3 sends at most 1000. */
  readonly pageSize?: number;
}

const CREDENTIALS = {
  accessKeyId: "fake-access",
  secretAccessKey: "fake-secret",
};

export const FAKE_S3 = {
  endpoint: new URL("http://s3.test"),
  region: "us-east-1",
  bucket: "docs",
  credentials: CREDENTIALS,
} as const;

function parseAmzDate(value: string): Date {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new Error(`bad x-amz-date ${value}`);
  const [, y, mo, d, h, mi, s] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}

function xml(status: number, code: string): Response {
  return new Response(`<Error><Code>${code}</Code></Error>`, { status });
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * An in-memory, path-style S3 endpoint that checks requests the way S3 does:
 * the body must match `x-amz-content-sha256` and the SigV4 signature must
 * match one recomputed with the shared secret.
 */
export function createFakeS3(options: FakeS3Options = {}): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const modified = new Map<string, Date>();
  const requests: RecordedRequest[] = [];
  const pageSize = options.pageSize ?? 1000;

  function list(params: URLSearchParams): Response {
    if (params.get("list-type") !== "2") return xml(400, "InvalidArgument");
    const prefix = params.get("prefix") ?? "";
    const after = params.get("continuation-token");
    const keys = [...objects.keys()]
      .filter(
        (key) => key.startsWith(prefix) && (after === null || key > after),
      )
      .toSorted();
    const page = keys.slice(0, pageSize);
    const last = page.at(-1);
    const isTruncated = keys.length > page.length && last !== undefined;
    const contents = page.map(
      (key) =>
        `<Contents><Key>${escapeXml(key)}</Key><LastModified>${(modified.get(key) ?? new Date(0)).toISOString()}</LastModified><ETag>&quot;x&quot;</ETag><Size>${objects.get(key)?.byteLength ?? 0}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    );
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${FAKE_S3.bucket}</Name><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${isTruncated}</IsTruncated>${isTruncated ? `<NextContinuationToken>${escapeXml(last)}</NextContinuationToken>` : ""}${contents.join("")}</ListBucketResult>`,
      { status: 200, headers: { "content-type": "application/xml" } },
    );
  }

  async function handle(input: Request): Promise<Response> {
    const url = new URL(input.url);
    const headers = Object.fromEntries(input.headers.entries());
    requests.push({ method: input.method, url, headers });
    const body = new Uint8Array(await input.arrayBuffer());

    const payloadHash = headers["x-amz-content-sha256"] ?? "";
    if (payloadHash !== sha256Hex(body)) {
      return xml(400, "XAmzContentSHA256Mismatch");
    }
    const authorization = headers.authorization ?? "";
    const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1];
    const date = headers["x-amz-date"];
    if (!signedNames || !date) return xml(403, "AccessDenied");
    const expected = signRequest({
      method: input.method,
      url,
      headers: signedNames
        .split(";")
        .filter((name) => name !== "host" && name !== "x-amz-date")
        .map((name) => [name, headers[name] ?? ""] as const),
      payloadHash,
      credentials: CREDENTIALS,
      region: FAKE_S3.region,
      service: "s3",
      date: parseAmzDate(date),
    });
    if (expected.headers.authorization !== authorization) {
      return xml(403, "SignatureDoesNotMatch");
    }

    const bucket = `/${FAKE_S3.bucket}`;
    if (url.pathname === bucket || url.pathname === `${bucket}/`) {
      return input.method === "GET"
        ? list(url.searchParams)
        : xml(405, "MethodNotAllowed");
    }
    const prefix = `${bucket}/`;
    if (!url.pathname.startsWith(prefix)) return xml(404, "NoSuchBucket");
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const object = objects.get(key);
    switch (input.method) {
      case "PUT":
        objects.set(key, body);
        modified.set(key, new Date());
        return new Response(null, { status: 200 });
      case "GET":
        return object
          ? new Response(object, { status: 200 })
          : xml(404, "NoSuchKey");
      case "HEAD":
        return object
          ? new Response(null, {
              status: 200,
              headers: {
                "content-length": String(object.byteLength),
                "last-modified": (
                  modified.get(key) ?? new Date(0)
                ).toUTCString(),
              },
            })
          : new Response(null, { status: 404 });
      case "DELETE":
        objects.delete(key);
        modified.delete(key);
        return new Response(null, { status: 204 });
      default:
        return xml(405, "MethodNotAllowed");
    }
  }

  return {
    fetch: (input, init) => handle(new Request(input, init)),
    objects,
    modified,
    requests,
  };
}
