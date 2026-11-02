import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string | undefined;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-security-token`, which are added. Repeated names are allowed. */
  readonly headers: readonly (readonly [name: string, value: string])[];
  /** Lowercase hex SHA-256 of the body. */
  readonly payloadHash: string;
  readonly credentials: S3Credentials;
  readonly region: string;
  readonly service: string;
  readonly date: Date;
}

export interface SignedRequest {
  /** The headers to send: the input headers, `x-amz-date`, `authorization` and, with a session token, `x-amz-security-token`. `host` is left to `fetch`. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding: everything but `A-Z a-z 0-9 - . _ ~` is percent-encoded. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// S3 signs the path as sent, each segment encoded once (no normalization or
// double encoding, unlike the other AWS services).
function canonicalPath(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const query = url.search.slice(1);
  if (query === "") return "";
  return query
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const equals = pair.indexOf("=");
      const key = equals < 0 ? pair : pair.slice(0, equals);
      const value = equals < 0 ? "" : pair.slice(equals + 1);
      return [
        encodeRfc3986(decodeURIComponent(key)),
        encodeRfc3986(decodeURIComponent(value)),
      ] as const;
    })
    .toSorted(([a, x], [b, y]) =>
      a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function timestampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Signs a request with AWS Signature Version 4 (header-based). */
export function signRequest(input: SignInput): SignedRequest {
  const timestamp = timestampOf(input.date);
  const day = timestamp.slice(0, 8);
  const { accessKeyId, secretAccessKey, sessionToken } = input.credentials;

  const extra: [string, string][] = [["x-amz-date", timestamp]];
  if (sessionToken) extra.push(["x-amz-security-token", sessionToken]);
  const values = new Map<string, string[]>([["host", [input.url.host]]]);
  for (const [name, value] of [...input.headers, ...extra]) {
    const key = name.toLowerCase();
    const normalized = value.trim().replace(/\s+/g, " ");
    values.set(key, [...(values.get(key) ?? []), normalized]);
  }
  const names = [...values.keys()].toSorted();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${(values.get(name) ?? []).join(",")}\n`)
    .join("");

  const canonicalRequest = [
    input.method,
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${secretAccessKey}`, day), input.region),
      input.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  const headers: Record<string, string> = {};
  for (const [name, value] of [...input.headers, ...extra]) {
    headers[name.toLowerCase()] = value;
  }
  headers.authorization = `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
