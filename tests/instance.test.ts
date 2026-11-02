import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_ENTRY_TYPE, type Context } from "@docleus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeS3, FAKE_S3 } from "./fake-s3.ts";
import {
  ensureBucket,
  TEST_S3,
  testClient,
  uniquePrefix,
  type TestS3,
} from "./s3-env.ts";

interface Instance {
  readonly ctx: Context;
  fetch(request: Request): Promise<Response>;
  dispose(): Promise<void>;
}

interface ServerModule {
  createInstance(options: {
    baseDir: string;
    plugins: readonly {
      id: string;
      plugin: string;
      config?: unknown;
    }[];
    siteRuntimeDir: string;
    isDev: boolean;
  }): Promise<Instance>;
}

// A literal specifier would pull core's sources into this package's
// typecheck. The module is typed here with the part the tests use.
const SERVER_MODULE: string = "@docleus/server";

const ORIGIN = "http://localhost";
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

// The real manifest with its server entry pointed at the sources, so the
// test needs no build.
async function pluginDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "docleus-blobs-s3-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const manifest = JSON.parse(
    await readFile(join(ROOT, "docleus.plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  await writeFile(
    join(dir, "docleus.plugin.json"),
    JSON.stringify({
      ...manifest,
      entries: { server: join(ROOT, "src/server/index.ts") },
    }),
  );
  return dir;
}

async function boot(config: Record<string, unknown>): Promise<Instance> {
  const server = (await import(SERVER_MODULE)) as ServerModule;
  const instance = await server.createInstance({
    baseDir: ROOT,
    plugins: [{ id: "blobs-s3", plugin: await pluginDir(), config }],
    siteRuntimeDir: fileURLToPath(
      new URL("./fixtures/site-runtime/", import.meta.url),
    ),
    isDev: true,
  });
  cleanups.push(() => instance.dispose());
  return instance;
}

async function call<T>(
  instance: Instance,
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await instance.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(token && { authorization: `Bearer ${token}` }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
  );
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Publishes a one-page site through the API and returns its home page. */
async function publishAndRead(instance: Instance): Promise<Response> {
  const { token } = await call<{ token: string }>(
    instance,
    undefined,
    "POST",
    "/api/auth/dev-login",
    { email: "ada@example.com" },
  );
  const { org } = await call<{ org: { id: string } }>(
    instance,
    token,
    "POST",
    "/api/orgs",
    { slug: "acme", name: "Acme" },
  );
  const { space } = await call<{ space: { id: string } }>(
    instance,
    token,
    "POST",
    `/api/orgs/${org.id}/spaces`,
    { slug: "docs", name: "Docs" },
  );
  await instance.ctx.content.commit({
    spaceId: space.id,
    parent: undefined,
    put: {
      home: {
        type: PAGE_ENTRY_TYPE,
        title: "Stored in S3",
        parent: undefined,
        order: 0,
        fields: {},
        body: { id: "root", type: "doc", v: 1, attrs: {}, content: [] },
      },
    },
    message: "Initial",
  });
  const sites = `/api/orgs/${org.id}/sites`;
  const { site } = await call<{ site: { id: string } }>(
    instance,
    token,
    "POST",
    sites,
    { slug: "docs", name: "Docs", spaces: [{ spaceId: space.id, path: "" }] },
  );
  await call(instance, token, "POST", `${sites}/${site.id}/publications`);
  return instance.fetch(new Request(`${ORIGIN}/sites/acme/docs/`));
}

describe("an instance configured with docleus-plugin-blobs-s3", () => {
  it("stores published sites in the bucket (in-process fake S3)", async () => {
    const s3 = createFakeS3();
    vi.stubGlobal("fetch", s3.fetch);
    const instance = await boot({
      endpoint: FAKE_S3.endpoint.href,
      bucket: FAKE_S3.bucket,
      ...FAKE_S3.credentials,
      forcePathStyle: true,
      prefix: "instance",
    });

    const home = await publishAndRead(instance);
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Stored in S3");
    const keys = [...s3.objects.keys()];
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key.startsWith("instance/"))).toBe(true);
  });

  describe.skipIf(!TEST_S3)("against DOCLEUS_TEST_S3_ENDPOINT", () => {
    const s3 = TEST_S3 as TestS3;

    it("publishes a site and serves it back from the bucket", async () => {
      await ensureBucket(s3);
      const prefix = uniquePrefix();
      const instance = await boot({
        endpoint: s3.endpoint,
        region: s3.region,
        bucket: s3.bucket,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        forcePathStyle: s3.forcePathStyle,
        prefix,
      });
      const stored = new Set<string>();
      const put = instance.ctx.blobs.put.bind(instance.ctx.blobs);
      vi.spyOn(instance.ctx.blobs, "put").mockImplementation(async (data) => {
        const stat = await put(data);
        stored.add(stat.hash);
        return stat;
      });
      cleanups.push(async () => {
        const client = testClient(s3);
        for (const hash of stored) {
          await client.deleteObject(
            `${prefix}${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`,
          );
        }
      });

      const home = await publishAndRead(instance);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("Stored in S3");
      expect(stored.size).toBeGreaterThan(0);
      const client = testClient(s3);
      for (const hash of stored) {
        const key = `${prefix}${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
        expect(await client.headObject(key)).toBeDefined();
      }
    });
  });
});
