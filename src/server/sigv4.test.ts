import { describe, expect, it } from "vitest";
import { sha256Hex, signRequest } from "./sigv4.ts";

const EMPTY_HASH = sha256Hex("");

interface Vector {
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly body?: string;
  readonly signedHeaders: string;
  readonly signature: string;
}

// From the AWS Signature Version 4 test suite (Apache-2.0, "Copyright 2019
// Amazon.com, Inc. or its affiliates"), as shipped in botocore's
// tests/unit/auth/aws4_testsuite. Vectors that normalize paths (other AWS
// services, not S3) are left out.
const SUITE_CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const SUITE_VECTORS: readonly Vector[] = [
  {
    name: "get-vanilla",
    method: "GET",
    path: "/",
    signedHeaders: "host;x-amz-date",
    signature:
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
  },
  {
    name: "get-vanilla-empty-query-key",
    method: "GET",
    path: "/?Param1=value1",
    signedHeaders: "host;x-amz-date",
    signature:
      "a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb",
  },
  {
    name: "get-vanilla-query-order-key-case",
    method: "GET",
    path: "/?Param2=value2&Param1=value1",
    signedHeaders: "host;x-amz-date",
    signature:
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
  },
  {
    name: "get-vanilla-query-unreserved",
    method: "GET",
    path: "/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    signedHeaders: "host;x-amz-date",
    signature:
      "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
  },
  {
    name: "get-vanilla-utf8-query",
    method: "GET",
    path: "/?ሴ=bar",
    signedHeaders: "host;x-amz-date",
    signature:
      "2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04",
  },
  {
    name: "get-unreserved",
    method: "GET",
    path: "/-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    signedHeaders: "host;x-amz-date",
    signature:
      "07ef7494c76fa4850883e2b006601f940f8a34d404d0cfa977f52a65bbf5f24f",
  },
  {
    name: "get-utf8",
    method: "GET",
    path: "/ሴ",
    signedHeaders: "host;x-amz-date",
    signature:
      "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
  },
  {
    name: "get-header-key-duplicate",
    method: "GET",
    path: "/",
    headers: [
      ["My-Header1", "value2"],
      ["My-Header1", "value2"],
      ["My-Header1", "value1"],
    ],
    signedHeaders: "host;my-header1;x-amz-date",
    signature:
      "c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea",
  },
  {
    name: "get-header-value-order",
    method: "GET",
    path: "/",
    headers: [
      ["My-Header1", "value4"],
      ["My-Header1", "value1"],
      ["My-Header1", "value3"],
      ["My-Header1", "value2"],
    ],
    signedHeaders: "host;my-header1;x-amz-date",
    signature:
      "08c7e5a9acfcfeb3ab6b2185e75ce8b1deb5e634ec47601a50643f830c755c01",
  },
  {
    name: "get-header-value-trim",
    method: "GET",
    path: "/",
    headers: [
      ["My-Header1", " value1"],
      ["My-Header2", ' "a   b   c"'],
    ],
    signedHeaders: "host;my-header1;my-header2;x-amz-date",
    signature:
      "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
  },
  {
    name: "post-vanilla",
    method: "POST",
    path: "/",
    signedHeaders: "host;x-amz-date",
    signature:
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
  },
  {
    name: "post-vanilla-query",
    method: "POST",
    path: "/?Param1=value1",
    signedHeaders: "host;x-amz-date",
    signature:
      "28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11",
  },
  {
    name: "post-header-key-sort",
    method: "POST",
    path: "/",
    headers: [["My-Header1", "value1"]],
    signedHeaders: "host;my-header1;x-amz-date",
    signature:
      "c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c",
  },
  {
    name: "post-x-www-form-urlencoded",
    method: "POST",
    path: "/",
    headers: [["Content-Type", "application/x-www-form-urlencoded"]],
    body: "Param1=value1",
    signedHeaders: "content-type;host;x-amz-date",
    signature:
      "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
  },
];

function signSuiteVector(vector: Vector, sessionToken?: string) {
  return signRequest({
    method: vector.method,
    url: new URL(`https://example.amazonaws.com${vector.path}`),
    headers: vector.headers ?? [],
    payloadHash: sha256Hex(vector.body ?? ""),
    credentials: { ...SUITE_CREDENTIALS, sessionToken },
    region: "us-east-1",
    service: "service",
    date: new Date("2015-08-30T12:36:00Z"),
  });
}

describe("signRequest against the AWS SigV4 test suite", () => {
  for (const vector of SUITE_VECTORS) {
    it(vector.name, () => {
      const signed = signSuiteVector(vector);
      expect(signed.headers.authorization).toBe(
        `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=${vector.signedHeaders}, Signature=${vector.signature}`,
      );
      expect(signed.headers["x-amz-date"]).toBe("20150830T123600Z");
    });
  }

  it("get-vanilla: canonical request and string to sign", () => {
    const signed = signSuiteVector({
      name: "get-vanilla",
      method: "GET",
      path: "/",
      signedHeaders: "",
      signature: "",
    });
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_HASH,
      ].join("\n"),
    );
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
  });

  it("get-vanilla-with-session-token", () => {
    const token =
      "6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267";
    const signed = signSuiteVector(
      {
        name: "get-vanilla-with-session-token",
        method: "GET",
        path: "/",
        signedHeaders: "",
        signature: "",
      },
      token,
    );
    expect(signed.headers["x-amz-security-token"]).toBe(token);
    expect(signed.signature).toBe(
      "07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8",
    );
  });
});

// The examples of "Signature Calculations for the Authorization Header:
// Transferring Payload in a Single Chunk" in the Amazon S3 API reference.
describe("signRequest against the Amazon S3 documentation examples", () => {
  const credentials = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };
  const sign = (
    method: string,
    path: string,
    headers: readonly (readonly [string, string])[],
    payloadHash: string,
  ) =>
    signRequest({
      method,
      url: new URL(`https://examplebucket.s3.amazonaws.com${path}`),
      headers: [["x-amz-content-sha256", payloadHash], ...headers],
      payloadHash,
      credentials,
      region: "us-east-1",
      service: "s3",
      date: new Date("2013-05-24T00:00:00Z"),
    });

  it("GET Object", () => {
    const signed = sign(
      "GET",
      "/test.txt",
      [["Range", "bytes=0-9"]],
      EMPTY_HASH,
    );
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT Object", () => {
    const body = "Welcome to Amazon S3.";
    const signed = sign(
      "PUT",
      "/test$file.text",
      [
        ["Date", "Fri, 24 May 2013 00:00:00 GMT"],
        ["x-amz-storage-class", "REDUCED_REDUNDANCY"],
      ],
      sha256Hex(body),
    );
    expect(signed.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
    expect(signed.signature).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("GET Bucket Lifecycle", () => {
    const signed = sign("GET", "/?lifecycle", [], EMPTY_HASH);
    expect(signed.canonicalRequest.split("\n")[2]).toBe("lifecycle=");
    expect(signed.signature).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("GET Bucket (List Objects)", () => {
    const signed = sign("GET", "/?max-keys=2&prefix=J", [], EMPTY_HASH);
    expect(signed.signature).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});
