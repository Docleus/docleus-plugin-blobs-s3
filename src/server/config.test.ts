import { describe, expect, it } from "vitest";
import { parseS3Config } from "./config.ts";

const MINIMAL = {
  bucket: "docs",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

function rejection(config: unknown, env = {}): string {
  try {
    parseS3Config(config, env);
  } catch (error) {
    expect(error).toMatchObject({ code: "blobs-s3/invalid-config" });
    return (error as Error).message;
  }
  throw new Error("expected the config to be rejected");
}

describe("parseS3Config", () => {
  it("defaults to AWS in us-east-1 with virtual-hosted URLs and no prefix", () => {
    expect(parseS3Config(MINIMAL, {})).toEqual({
      endpoint: new URL("https://s3.us-east-1.amazonaws.com"),
      region: "us-east-1",
      bucket: "docs",
      accessKeyId: "key",
      secretAccessKey: "secret",
      sessionToken: undefined,
      prefix: "",
      forcePathStyle: false,
      signingSecret: undefined,
      requestTimeoutMs: 30_000,
    });
  });

  it("derives the AWS endpoint from the region", () => {
    expect(
      parseS3Config({ ...MINIMAL, region: "eu-west-3" }, {}).endpoint.href,
    ).toBe("https://s3.eu-west-3.amazonaws.com/");
  });

  it("keeps an endpoint base path without its trailing slash", () => {
    const config = parseS3Config(
      {
        ...MINIMAL,
        endpoint: "http://127.0.0.1:9000/s3/",
        forcePathStyle: true,
      },
      {},
    );
    expect(config.endpoint.pathname).toBe("/s3");
    expect(config.forcePathStyle).toBe(true);
  });

  it("normalizes the prefix to end with a slash and not start with one", () => {
    expect(parseS3Config({ ...MINIMAL, prefix: "/a/b" }, {}).prefix).toBe(
      "a/b/",
    );
    expect(parseS3Config({ ...MINIMAL, prefix: "a/" }, {}).prefix).toBe("a/");
  });

  it("reads secrets missing from the config from the environment", () => {
    const config = parseS3Config(
      { bucket: "docs" },
      {
        DOCLEUS_S3_ACCESS_KEY_ID: "env-key",
        DOCLEUS_S3_SECRET_ACCESS_KEY: "env-secret",
        DOCLEUS_S3_SESSION_TOKEN: "env-token",
        DOCLEUS_S3_SIGNING_SECRET: "s".repeat(32),
      },
    );
    expect(config).toMatchObject({
      accessKeyId: "env-key",
      secretAccessKey: "env-secret",
      sessionToken: "env-token",
      signingSecret: "s".repeat(32),
    });
  });

  it("checks the length of a signing secret from the environment", () => {
    expect(
      rejection(MINIMAL, { DOCLEUS_S3_SIGNING_SECRET: "short" }),
    ).toContain("at least 32");
  });

  it("prefers the config over the environment", () => {
    const config = parseS3Config(MINIMAL, {
      DOCLEUS_S3_ACCESS_KEY_ID: "env-key",
    });
    expect(config.accessKeyId).toBe("key");
  });

  it.each([
    [undefined, "bucket is required"],
    [[], "expected an object"],
    [{ ...MINIMAL, bucket: "Bad_Bucket" }, "bucket is not a valid"],
    [{ ...MINIMAL, bucket: "" }, "bucket must be a non-empty string"],
    [{ ...MINIMAL, bucket: 42 }, "bucket must be a non-empty string"],
    ["docs", "expected an object"],
    [{ ...MINIMAL, signingSecret: 7 }, "signingSecret must be a non-empty"],
    [{ ...MINIMAL, region: "US EAST" }, "region must match"],
    [{ ...MINIMAL, endpoint: "not a url" }, "endpoint must be a URL"],
    [{ ...MINIMAL, endpoint: "ftp://host" }, "http(s) URL"],
    [{ ...MINIMAL, endpoint: "https://u:p@host" }, "credentials"],
    [{ ...MINIMAL, endpoint: "https://host/?x=1" }, "a query"],
    [{ ...MINIMAL, prefix: "a/../b" }, '".."'],
    [{ ...MINIMAL, forcePathStyle: "yes" }, "forcePathStyle"],
    [{ ...MINIMAL, requestTimeoutMs: 0 }, "requestTimeoutMs"],
    [{ ...MINIMAL, signingSecret: "short" }, "at least 32"],
    [{ ...MINIMAL, bukket: "typo" }, 'unknown key "bukket"'],
    [{ bucket: "docs", secretAccessKey: "s" }, "DOCLEUS_S3_ACCESS_KEY_ID"],
    [{ bucket: "docs", accessKeyId: "k" }, "DOCLEUS_S3_SECRET_ACCESS_KEY"],
    [{ ...MINIMAL, accessKeyId: "" }, "accessKeyId must be a non-empty"],
  ])("rejects %j", (config, message) => {
    expect(rejection(config)).toContain(message);
  });
});
