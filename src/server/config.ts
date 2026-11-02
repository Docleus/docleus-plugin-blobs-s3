import { DocleusError, z } from "@docleus/sdk";

export interface S3BlobsConfig {
  /** Origin (and optional base path) of the S3 API. */
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | undefined;
  /** Prepended to every object key; empty or ending in `/`. */
  readonly prefix: string;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  readonly forcePathStyle: boolean;
  /** Secret for read tokens (`sign`/`verify`), shared by every instance that serves the same blobs; random per process when omitted. */
  readonly signingSecret: string | undefined;
  readonly requestTimeoutMs: number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_REGION = "us-east-1";
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_SIGNING_SECRET_LENGTH = 32;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]+$/;

/** Secrets may come from the environment instead of the deployment config. */
export const ENV_FALLBACKS = {
  accessKeyId: "DOCLEUS_S3_ACCESS_KEY_ID",
  secretAccessKey: "DOCLEUS_S3_SECRET_ACCESS_KEY",
  sessionToken: "DOCLEUS_S3_SESSION_TOKEN",
  signingSecret: "DOCLEUS_S3_SIGNING_SECRET",
} as const;

function nonEmpty(key: string) {
  const message = `${key} must be a non-empty string`;
  return z
    .string({ error: message })
    .refine((value) => value.trim() !== "", message);
}

const EndpointSchema = nonEmpty("endpoint").transform((text, ctx) => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    ctx.addIssue({ code: "custom", message: "endpoint must be a URL" });
    return z.NEVER;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    ctx.addIssue({
      code: "custom",
      message: "endpoint must be an http(s) URL",
    });
    return z.NEVER;
  }
  if (url.search !== "" || url.hash !== "" || url.username || url.password) {
    ctx.addIssue({
      code: "custom",
      message: "endpoint must not have credentials, a query or a fragment",
    });
    return z.NEVER;
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
});

const PrefixSchema = nonEmpty("prefix")
  .transform((value) => value.replace(/^\/+/, ""))
  .refine(
    (prefix) =>
      !prefix.split("/").some((part) => part === "." || part === ".."),
    'prefix must not contain "." or ".." segments',
  )
  .transform((prefix) =>
    prefix === "" || prefix.endsWith("/") ? prefix : `${prefix}/`,
  );

const TIMEOUT_MESSAGE = "requestTimeoutMs must be a positive integer";

const ConfigSchema = z.strictObject(
  {
    endpoint: EndpointSchema.optional(),
    region: nonEmpty("region")
      .regex(REGION, `region must match ${String(REGION)}`)
      .default(DEFAULT_REGION),
    bucket: z
      .string({
        error: (issue) =>
          issue.input === undefined
            ? "bucket is required"
            : "bucket must be a non-empty string",
      })
      .refine(
        (value) => value.trim() !== "",
        "bucket must be a non-empty string",
      )
      .regex(BUCKET, "bucket is not a valid bucket name"),
    accessKeyId: nonEmpty("accessKeyId").optional(),
    secretAccessKey: nonEmpty("secretAccessKey").optional(),
    sessionToken: nonEmpty("sessionToken").optional(),
    prefix: PrefixSchema.default(""),
    forcePathStyle: z
      .boolean({ error: "forcePathStyle must be a boolean" })
      .default(false),
    signingSecret: nonEmpty("signingSecret").optional(),
    requestTimeoutMs: z
      .number({ error: TIMEOUT_MESSAGE })
      .int(TIMEOUT_MESSAGE)
      .positive(TIMEOUT_MESSAGE)
      .default(DEFAULT_TIMEOUT_MS),
  },
  { error: "expected an object" },
);

const SecretsSchema = z.object({
  accessKeyId: z.string({
    error: `accessKeyId is required (or set ${ENV_FALLBACKS.accessKeyId})`,
  }),
  secretAccessKey: z.string({
    error: `secretAccessKey is required (or set ${ENV_FALLBACKS.secretAccessKey})`,
  }),
  sessionToken: z.string().optional(),
  signingSecret: z
    .string()
    .min(
      MIN_SIGNING_SECRET_LENGTH,
      `signingSecret must be at least ${MIN_SIGNING_SECRET_LENGTH} characters`,
    )
    .optional(),
});

function invalid(error: z.ZodError): DocleusError {
  const [issue] = error.issues;
  const message =
    issue?.code === "unrecognized_keys"
      ? `unknown key ${JSON.stringify(issue.keys[0])}`
      : (issue?.message ?? "invalid");
  return new DocleusError(
    "blobs-s3/invalid-config",
    `invalid config: ${message}`,
  );
}

function fromEnv(
  env: Environment,
  key: keyof typeof ENV_FALLBACKS,
): string | undefined {
  const value = env[ENV_FALLBACKS[key]];
  return value === "" ? undefined : value;
}

/**
 * Validates the plugin config; throws `blobs-s3/invalid-config` with the
 * first problem found. Secrets missing from the config are read from
 * {@link ENV_FALLBACKS} in `env`.
 */
export function parseS3Config(value: unknown, env: Environment): S3BlobsConfig {
  const parsed = ConfigSchema.safeParse(value ?? {});
  if (!parsed.success) throw invalid(parsed.error);
  const config = parsed.data;
  const secrets = SecretsSchema.safeParse({
    accessKeyId: config.accessKeyId ?? fromEnv(env, "accessKeyId"),
    secretAccessKey: config.secretAccessKey ?? fromEnv(env, "secretAccessKey"),
    sessionToken: config.sessionToken ?? fromEnv(env, "sessionToken"),
    signingSecret: config.signingSecret ?? fromEnv(env, "signingSecret"),
  });
  if (!secrets.success) throw invalid(secrets.error);

  return {
    endpoint:
      config.endpoint ?? new URL(`https://s3.${config.region}.amazonaws.com`),
    region: config.region,
    bucket: config.bucket,
    accessKeyId: secrets.data.accessKeyId,
    secretAccessKey: secrets.data.secretAccessKey,
    sessionToken: secrets.data.sessionToken,
    prefix: config.prefix,
    forcePathStyle: config.forcePathStyle,
    signingSecret: secrets.data.signingSecret,
    requestTimeoutMs: config.requestTimeoutMs,
  };
}
