import { DocleusError, z } from "@docleus/sdk";
import {
  encodeRfc3986,
  sha256Hex,
  signRequest,
  type S3Credentials,
} from "./sigv4.ts";

export interface S3ClientOptions {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  readonly forcePathStyle: boolean;
  readonly requestTimeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export interface S3ObjectInfo {
  readonly size: number;
  /** When the object was last written, in ms since epoch, by the store's clock. */
  readonly lastModified: number;
}

export interface S3ListedObject extends S3ObjectInfo {
  readonly key: string;
}

export interface S3ObjectPage {
  readonly objects: readonly S3ListedObject[];
  /** Pass to the next `listObjects` call; undefined on the last page. */
  readonly nextContinuationToken: string | undefined;
}

/** The object operations `blobs` needs, on one bucket. */
export interface S3Client {
  /** `contentHash` is the lowercase hex SHA-256 of `body`, sent as `x-amz-content-sha256`. */
  putObject(key: string, body: Uint8Array, contentHash: string): Promise<void>;
  getObject(key: string): Promise<Uint8Array | undefined>;
  headObject(key: string): Promise<S3ObjectInfo | undefined>;
  deleteObject(key: string): Promise<void>;
  /** One page of `ListObjectsV2` over the keys that start with `prefix`. */
  listObjects(
    prefix: string,
    continuationToken?: string,
  ): Promise<S3ObjectPage>;
}

const EMPTY_HASH = sha256Hex("");

function errorCodeOf(body: string): string | undefined {
  return /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
}

const DECIMAL = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().safe());
const TIMESTAMP = z.string().transform(Date.parse).pipe(z.number());

const HeadHeadersSchema = z.object({
  "content-length": DECIMAL,
  "last-modified": TIMESTAMP,
});

const ListedObjectSchema = z.object({
  Key: z.string().min(1),
  Size: DECIMAL,
  LastModified: TIMESTAMP,
});

const ListResultSchema = z
  .object({
    IsTruncated: z.enum(["true", "false"]),
    NextContinuationToken: z.string().min(1).optional(),
  })
  .refine(
    (result) =>
      result.IsTruncated === "false" ||
      result.NextContinuationToken !== undefined,
    "a truncated listing has no NextContinuationToken",
  );

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (entity, name) => {
    const code = name.startsWith("#x")
      ? Number.parseInt(name.slice(2), 16)
      : name.startsWith("#")
        ? Number.parseInt(name.slice(1), 10)
        : undefined;
    if (code !== undefined) return String.fromCodePoint(code);
    return ENTITIES[name] ?? entity;
  });
}

/** The text of each direct child element of `xml` that has no children of its own. */
function leafElements(xml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, name, text] of xml.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/g)) {
    if (name !== undefined && text !== undefined && !(name in fields)) {
      fields[name] = unescapeXml(text);
    }
  }
  return fields;
}

// S3 answers with flat, namespace-free XML in a fixed shape, so a full XML
// parser (and a runtime dependency) is not needed to read it.
function parseListResult(body: string): S3ObjectPage | undefined {
  if (!/<ListBucketResult[\s>]/.test(body)) return undefined;
  const objects: S3ListedObject[] = [];
  for (const [, contents] of body.matchAll(
    /<Contents>([\s\S]*?)<\/Contents>/g,
  )) {
    const parsed = ListedObjectSchema.safeParse(leafElements(contents ?? ""));
    if (!parsed.success) return undefined;
    objects.push({
      key: parsed.data.Key,
      size: parsed.data.Size,
      lastModified: parsed.data.LastModified,
    });
  }
  const rest = body.replace(/<Contents>[\s\S]*?<\/Contents>/g, "");
  const result = ListResultSchema.safeParse(leafElements(rest));
  if (!result.success) return undefined;
  return {
    objects,
    nextContinuationToken:
      result.data.IsTruncated === "true"
        ? result.data.NextContinuationToken
        : undefined,
  };
}

export function objectUrl(options: S3ClientOptions, key: string): URL {
  const url = new URL(options.endpoint.href);
  const path = key.split("/").map(encodeRfc3986).join("/");
  const base = url.pathname.replace(/\/+$/, "");
  if (options.forcePathStyle) {
    url.pathname = `${base}/${encodeRfc3986(options.bucket)}/${path}`;
  } else {
    url.hostname = `${options.bucket}.${url.hostname}`;
    url.pathname = `${base}/${path}`;
  }
  return url;
}

/** The URL of the bucket itself, with `query` already encoded. */
function bucketUrl(options: S3ClientOptions, query: string): URL {
  const url = objectUrl(options, "");
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  url.search = query;
  return url;
}

/** A minimal S3 client over `fetch`, signing every request with SigV4 over the payload hash. */
export function createS3Client(options: S3ClientOptions): S3Client {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  async function send(
    method: "GET" | "HEAD" | "PUT" | "DELETE",
    url: URL,
    body?: { readonly bytes: Uint8Array; readonly hash: string },
  ): Promise<Response> {
    const payloadHash = body?.hash ?? EMPTY_HASH;
    const signed = signRequest({
      method,
      url,
      headers: [
        ["x-amz-content-sha256", payloadHash],
        ...(body
          ? ([["content-type", "application/octet-stream"]] as const)
          : []),
      ],
      payloadHash,
      credentials: options.credentials,
      region: options.region,
      service: "s3",
      date: now(),
    });
    try {
      return await doFetch(url, {
        method,
        headers: signed.headers,
        ...(body && { body: body.bytes }),
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
    } catch (error) {
      throw new DocleusError(
        "blobs-s3/request-failed",
        `${method} ${url.href} failed`,
        { cause: error },
      );
    }
  }

  async function fail(
    method: string,
    key: string,
    response: Response,
  ): Promise<never> {
    const text = method === "HEAD" ? "" : await response.text();
    const code = errorCodeOf(text);
    throw new DocleusError(
      "blobs-s3/request-failed",
      `${method} ${options.bucket}/${key}: ${response.status}${code ? ` ${code}` : ""}`,
    );
  }

  return {
    async putObject(key, bytes, hash) {
      const response = await send("PUT", objectUrl(options, key), {
        bytes,
        hash,
      });
      if (!response.ok) return fail("PUT", key, response);
      await response.body?.cancel();
    },
    async getObject(key) {
      const response = await send("GET", objectUrl(options, key));
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) return fail("GET", key, response);
      return new Uint8Array(await response.arrayBuffer());
    },
    async headObject(key) {
      const response = await send("HEAD", objectUrl(options, key));
      await response.body?.cancel();
      if (response.status === 404) return undefined;
      if (!response.ok) return fail("HEAD", key, response);
      const headers = HeadHeadersSchema.safeParse({
        "content-length": response.headers.get("content-length") ?? undefined,
        "last-modified": response.headers.get("last-modified") ?? undefined,
      });
      if (!headers.success) {
        throw new DocleusError(
          "blobs-s3/invalid-response",
          `HEAD ${options.bucket}/${key}: missing or invalid Content-Length or Last-Modified`,
        );
      }
      return {
        size: headers.data["content-length"],
        lastModified: headers.data["last-modified"],
      };
    },
    async deleteObject(key) {
      const response = await send("DELETE", objectUrl(options, key));
      if (!response.ok && response.status !== 404) {
        return fail("DELETE", key, response);
      }
      await response.body?.cancel();
    },
    async listObjects(prefix, continuationToken) {
      // Built by hand: URLSearchParams writes a space as `+`, which SigV4
      // canonicalization would not read back as a space.
      const query = [
        "list-type=2",
        `prefix=${encodeRfc3986(prefix)}`,
        ...(continuationToken === undefined
          ? []
          : [`continuation-token=${encodeRfc3986(continuationToken)}`]),
      ].join("&");
      const response = await send("GET", bucketUrl(options, query));
      const target = `?prefix=${prefix}`;
      if (!response.ok) return fail("GET", target, response);
      const page = parseListResult(await response.text());
      if (!page) {
        throw new DocleusError(
          "blobs-s3/invalid-response",
          `GET ${options.bucket}/${target}: not a valid ListObjectsV2 result`,
        );
      }
      return page;
    },
  };
}
