import { definePlugin } from "@docleus/sdk";
import { createS3BlobsService } from "./blobs.ts";
import { parseS3Config, type Environment } from "./config.ts";
import { createS3Client } from "./s3-client.ts";

export { createS3BlobsService, type S3BlobsOptions } from "./blobs.ts";
export {
  ENV_FALLBACKS,
  parseS3Config,
  type Environment,
  type S3BlobsConfig,
} from "./config.ts";
export {
  createS3Client,
  objectUrl,
  type S3Client,
  type S3ClientOptions,
} from "./s3-client.ts";
export {
  encodeRfc3986,
  sha256Hex,
  signRequest,
  type S3Credentials,
  type SignedRequest,
  type SignInput,
} from "./sigv4.ts";

export const PLUGIN_NAME = "@docleus/plugin-blobs-s3";

/** Test seams; the host loads {@link plugin} with the defaults. */
export interface BlobsS3PluginOptions {
  /** Where secrets missing from the config are read; defaults to `process.env`. */
  readonly env?: Environment;
  readonly fetch?: typeof fetch;
}

/**
 * Builds the plugin. The config is validated when the plugin applies and an
 * invalid one fails with `blobs-s3/invalid-config`.
 */
export function createBlobsS3Plugin(options: BlobsS3PluginOptions = {}) {
  return definePlugin({
    name: PLUGIN_NAME,
    provides: ["blobs"],
    apply(ctx, value: unknown) {
      const config = parseS3Config(value, options.env ?? process.env);
      const client = createS3Client({
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        credentials: config,
        forcePathStyle: config.forcePathStyle,
        requestTimeoutMs: config.requestTimeoutMs,
        fetch: options.fetch,
      });
      ctx.provide(
        "blobs",
        createS3BlobsService({
          client,
          prefix: config.prefix,
          signingSecret:
            config.signingSecret === undefined
              ? undefined
              : Buffer.from(config.signingSecret),
        }),
      );
      ctx
        .logger("blobs-s3")
        .info(
          "storing blobs in %s/%s%s",
          config.endpoint.host,
          config.bucket,
          config.prefix === "" ? "" : `/${config.prefix}`,
        );
    },
  });
}

/** Provides `blobs` on an S3-compatible bucket in place of core-blobs. */
export const plugin = createBlobsS3Plugin();
