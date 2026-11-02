import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  BLOB_PUT_REFRESH_MS,
  DocleusError,
  type BlobEntry,
  type BlobsService,
} from "@docleus/sdk";
import type { S3Client } from "./s3-client.ts";

export interface S3BlobsOptions {
  readonly client: S3Client;
  /** Prepended to every object key; empty or ending in `/`. */
  readonly prefix: string;
  /** HMAC key for read tokens; random per service when omitted. */
  readonly signingSecret?: Uint8Array | undefined;
  readonly now?: () => number;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    throw new DocleusError(
      "blobs/invalid-hash",
      `"${hash}" is not a SHA-256 hex digest`,
    );
  }
}

// Same token format as core-blobs: `<hash>.<expiresAt>.<hex HMAC-SHA256>`.
function sign(secret: Uint8Array, hash: string, expiresAt: number): string {
  const payload = `${hash}.${expiresAt}`;
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

function verify(secret: Uint8Array, token: string): string | undefined {
  const lastDot = token.lastIndexOf(".");
  const middleDot = token.lastIndexOf(".", lastDot - 1);
  if (lastDot < 0 || middleDot < 0) return undefined;
  const hash = token.slice(0, middleDot);
  if (!HASH_PATTERN.test(hash)) return undefined;
  const expiresAt = Number(token.slice(middleDot + 1, lastDot));
  const mac = Buffer.from(token.slice(lastDot + 1));
  const expected = Buffer.from(
    createHmac("sha256", secret).update(token.slice(0, lastDot)).digest("hex"),
  );
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return undefined;
  }
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return undefined;
  return hash;
}

/**
 * `blobs` on an S3 bucket: content-addressed objects under `prefix`, sharded
 * by hash prefix like core-blobs (`<prefix>ab/cd/<hash>`), with HMAC-signed
 * read tokens.
 */
export function createS3BlobsService(options: S3BlobsOptions): BlobsService {
  const { client, prefix } = options;
  const now = options.now ?? Date.now;
  const secret = options.signingSecret ?? randomBytes(32);
  const keyOf = (hash: string): string => {
    assertHash(hash);
    return `${prefix}${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
  };

  return {
    async put(data) {
      const hash = createHash("sha256").update(data).digest("hex");
      const key = keyOf(hash);
      // Content addressing makes an existing object the same bytes; it is
      // written again only to keep its Last-Modified within the refresh
      // window that blob garbage collection relies on.
      const head = await client.headObject(key);
      if (!head || head.lastModified <= now() - BLOB_PUT_REFRESH_MS) {
        await client.putObject(key, data, hash);
      }
      return { hash, size: data.byteLength };
    },
    async get(hash) {
      return client.getObject(keyOf(hash));
    },
    async stat(hash) {
      const head = await client.headObject(keyOf(hash));
      return head && { hash, size: head.size };
    },
    async delete(hash) {
      const key = keyOf(hash);
      // S3 answers DELETE with 204 whether or not the object existed.
      if (!(await client.headObject(key))) return false;
      await client.deleteObject(key);
      return true;
    },
    async *list(): AsyncGenerator<BlobEntry> {
      let token: string | undefined;
      do {
        const page = await client.listObjects(prefix, token);
        for (const object of page.objects) {
          const hash = object.key.slice(object.key.lastIndexOf("/") + 1);
          // Skip objects of other tools, or of deployments with a longer prefix.
          if (!HASH_PATTERN.test(hash) || keyOf(hash) !== object.key) continue;
          yield { hash, size: object.size, storedAt: object.lastModified };
        }
        token = page.nextContinuationToken;
      } while (token !== undefined);
    },
    sign(hash, expiresAt) {
      assertHash(hash);
      return sign(secret, hash, expiresAt);
    },
    verify: (token) => verify(secret, token),
  };
}
