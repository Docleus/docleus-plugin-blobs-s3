<p align="center">
  <a href="https://docleus.io"><img src="./.github/assets/docleus.svg" width="88" alt="Docleus logo" /></a>
</p>

<h1 align="center">S3 Storage</h1>

<p align="center">
  <strong>Your files. Your bucket.</strong><br />
  S3-compatible blob storage with AWS Signature V4 and no AWS SDK.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" /></a>
  <img alt="Public preview in preparation" src="https://img.shields.io/badge/preview-0.0.10-cfcfcf?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square" />
  <a href="https://docleus.io"><img alt="Online documentation" src="https://img.shields.io/badge/docs-docleus.io-111111?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://docleus.io">Documentation</a> &middot;
  <a href="#config">Configuration</a> &middot;
  <a href="https://github.com/Docleus/docleus">Run Docleus</a> &middot;
  <a href="https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md">Contribute</a>
</p>

---

Provides `ctx.blobs` on an S3-compatible object store (AWS S3, Cloudflare R2, MinIO, RustFS, Garage, ...) in place of core-blobs. Requests are signed with a hand-written AWS Signature Version 4 over `fetch` and `node:crypto`; there is no AWS SDK and no runtime dependency.

The manifest declares `provides: ["blobs"]`, so an instance configured with this plugin does not start core-blobs; services that use blobs (sites) wait for the plugin.

## Config

Add this row to the `plugins` list in the deployment config. Paths resolve
relative to that file. In the default distribution, patch its existing
`blobs` row instead: omit `plugin` and add `disabled: false`.

```yaml
plugins:
  - id: blobs
    plugin: ../docleus-plugin-blobs-s3
    config:
      bucket: docleus-blobs # required; must exist
      region: us-east-1 # the default
      endpoint: https://s3.us-east-1.amazonaws.com # the default for AWS; set it for any other store
      forcePathStyle: false # true sends https://endpoint/bucket/key (MinIO, RustFS, Garage)
      prefix: docleus/ # optional key prefix
      accessKeyId: ... # or DOCLEUS_S3_ACCESS_KEY_ID
      secretAccessKey: ... # or DOCLEUS_S3_SECRET_ACCESS_KEY
      sessionToken: ... # optional; or DOCLEUS_S3_SESSION_TOKEN
      signingSecret: ... # optional, at least 32 characters; or DOCLEUS_S3_SIGNING_SECRET
      requestTimeoutMs: 30000 # the default
```

Values in the config win over the environment. An invalid config fails the plugin with `blobs-s3/invalid-config`; unknown keys are rejected.

- Objects are content-addressed: `<prefix><hash[0:2]>/<hash[2:4]>/<sha256>`, the same layout as core-blobs. `put` sends `HEAD` first and skips the upload when the object exists, unless its `Last-Modified` is older than `BLOB_PUT_REFRESH_MS` (an hour): then it uploads again, so blob garbage collection sees the blob as freshly stored.
- `list` pages through `ListObjectsV2` under the prefix and yields only keys in the blob layout, with `Last-Modified` as `storedAt`. The core blob garbage collection job uses it to delete unreferenced blobs; other objects in the bucket are left alone.
- Every request signs the SHA-256 of its payload (`x-amz-content-sha256`); `UNSIGNED-PAYLOAD` is never used.
- `sign` / `verify` issue the same HMAC tokens as core-blobs. Set `signingSecret` when several instances serve the same blobs, or when tokens must survive a restart; without it the secret is random per process.
- A failed request throws `blobs-s3/request-failed` with the status and the S3 error code (for example `403 SignatureDoesNotMatch`); a `HEAD` without a usable `Content-Length` or `Last-Modified`, or a listing that is not a valid `ListObjectsV2` result, throws `blobs-s3/invalid-response`.

The credentials need `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket` on the bucket. `s3:ListBucket` lets garbage collection list blobs and makes a missing object answer 404 rather than 403.

## Tests

- `pnpm test`: SigV4 against the AWS test suite and the Amazon S3 documentation examples, unit tests, the blobs conformance suite, and an instance test (`@docleus/server` with this plugin publishing a site), all against an in-process fake S3 that verifies signatures and payload hashes (`tests/fake-s3.ts`).
- The conformance suite and the instance test also run against a real store when `DOCLEUS_TEST_S3_ENDPOINT`, `DOCLEUS_TEST_S3_ACCESS_KEY_ID` and `DOCLEUS_TEST_S3_SECRET_ACCESS_KEY` are set (optional: `DOCLEUS_TEST_S3_BUCKET`, default `docleus-test`, created if missing; `DOCLEUS_TEST_S3_REGION`, default `us-east-1`; `DOCLEUS_TEST_S3_FORCE_PATH_STYLE`, default `true`). Each run uses a fresh prefix and deletes what it stored. For example, with [RustFS](https://github.com/rustfs/rustfs):

```sh
docker run -d --name docleus-s3 -p 127.0.0.1:9000:9000 \
  -e RUSTFS_ACCESS_KEY=docleus -e RUSTFS_SECRET_KEY=docleus-secret \
  rustfs/rustfs:latest
DOCLEUS_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
  DOCLEUS_TEST_S3_ACCESS_KEY_ID=docleus \
  DOCLEUS_TEST_S3_SECRET_ACCESS_KEY=docleus-secret pnpm test
```

## Development

Use Node.js 24 and pnpm 11.21.0. Keep this repository next to `docleus-core`
with its original directory name; the `link:` development dependencies need
that layout. Install core before this repository:

```sh
pnpm --dir ../docleus-core install --frozen-lockfile
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs typecheck, lint, formatting, dependency boundaries, licenses,
and unit/in-process integration tests. Browser and external-service tests,
where provided, are separate and need the sibling repositories listed in
their setup files. The SDK is a host-provided peer dependency; packages remain
private and are not installed from npm. All extension points are experimental
before 1.0.

## Community

[Contributing](https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md) &middot;
[Code of conduct](https://github.com/Docleus/.github/blob/main/CODE_OF_CONDUCT.md) &middot;
[Security](https://github.com/Docleus/.github/blob/main/SECURITY.md) &middot;
[Support](https://github.com/Docleus/.github/blob/main/SUPPORT.md)

## License

[MIT](LICENSE)

## Compatibility

Version `0.0.10` supports Docleus core and SDK `0.0.1`, `0.0.2`, `0.0.3`, `0.0.4`, `0.0.5`, `0.0.6`, `0.0.7`, `0.0.8` and `0.0.9` through
the matching `>=0.0.1 <0.0.10` manifest and SDK peer ranges.
