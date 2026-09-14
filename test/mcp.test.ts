import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomBytes } from "node:crypto";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { startMcpFixture } from "../examples/mcp-fixture.js";
import {
  credentialKey,
  RemoteMcp,
  endpointPolicy,
  type McpConfiguration,
} from "../src/mcp.js";
import { defaultBounds, type Auth, type CodeOutput } from "../src/domain.js";
import { platformLayer } from "../src/runtime.js";
import { WorkManager, WorkJournal } from "../src/platform.js";
import { serve } from "../src/http.js";
import { BridgeRegistry } from "../src/backends/cloudflare.js";
import { WorkSchema } from "../src/schemas.js";
import { output } from "./fixture.js";

it.live(
  "real Executor + remote MCP: isolated catalogs, frozen admission, replacement, deduplication and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tokenA = randomBytes(32).toString("hex"),
          tokenB = randomBytes(32).toString("hex");
        const red = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMcpFixture({ label: "red", seed: 17, token: tokenA }),
          ),
          (f) => Effect.promise(f.close),
        );
        const blue = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startMcpFixture({ label: "blue", seed: 83, token: tokenB }),
          ),
          (f) => Effect.promise(f.close),
        );
        const directory = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp("/tmp/action-space-mcp-")),
          (path) =>
            Effect.promise(() => rm(path, { recursive: true, force: true })),
        );
        const refA = {
            id: "red",
            revision: "v1",
            identity: "fixture-user-red",
          },
          refB = { id: "blue", revision: "v1", identity: "fixture-user-blue" };
        const config: McpConfiguration = {
          registry: [red, blue].map((f, i) => ({
            id: i ? "blue" : "red",
            revision: "v1",
            source: "customer",
            endpoint: f.endpoint,
            privateCidrs: ["127.0.0.0/8"],
          })),
          connections: [refA, refB].map((ref) => ({
            id: ref.id,
            revision: "v1",
            registry: ref.id,
            credential: ref,
          })),
          credentials: [],
        };
        const mcp = new RemoteMcp(
          config,
          new Map([
            [credentialKey(refA), tokenA],
            [credentialKey(refB), tokenB],
          ]),
        );
        const a: Auth = {
          tenant: "tenant-a",
          actor: "agent-a",
          thread: "thread-a",
          reviewer: false,
          grants: [
            "code.execute",
            "mcp.configure",
            "mcp.use:red",
            "mcp.use:blue",
          ],
        };
        const b: Auth = {
          ...a,
          tenant: "tenant-b",
          actor: "agent-b",
          thread: "thread-b",
          grants: ["code.execute", "mcp.configure", "mcp.use:blue"],
        };
        const layer = () =>
          platformLayer({
            directory,
            principals: [a, b],
            mcp,
            settings: {
              autoRun: false,
              bounds: { ...defaultBounds, wallMs: 6000 },
            },
          });
        let saved = "";
        const intention = {
          code: 'const found=await tools.search({query:"red write"}); const schema=await tools.describe.tool({path:"mcp.red.write"}); const results=await Promise.all([tools.mcp.red.read({}),tools["mcp.red.write"]({amount:-6})]); return {paths:found.items.map(x=>x.path),typed:schema.inputTypeScript.includes("amount"),results};',
        };
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* WorkManager,
              journal = yield* WorkJournal;
            const server = yield* serve({
              port: 0,
              credentials: new Map([
                [tokenA, a],
                [tokenB, b],
              ]),
              bridges: new BridgeRegistry(),
            });
            const request = (
              token: string,
              path: string,
              method = "GET",
              body?: unknown,
              key = "",
            ) =>
              Effect.promise(async () => {
                const response = await fetch(
                  `http://127.0.0.1:${server.port}${path}`,
                  {
                    method,
                    headers: {
                      authorization: `Bearer ${token}`,
                      "content-type": "application/json",
                      "idempotency-key": key,
                    },
                    ...(body === undefined
                      ? {}
                      : { body: JSON.stringify(body) }),
                  },
                );
                return {
                  status: response.status,
                  body: (await response.json()) as any,
                };
              });
            const dispatch = Effect.fn(function* () {
              const work = yield* manager.claim();
              assert.isNotNull(work);
              if (work) yield* manager.dispatch(work);
            });
            assert.equal((yield* request("", "/v1/thread/tools")).status, 401);
            assert.equal(
              (yield* request(tokenA, "/v1/thread/tools", "PUT", {
                expectedRevision: 0,
                connections: ["red"],
              })).status,
              200,
            );
            assert.equal(
              (yield* request(tokenB, "/v1/thread/tools", "PUT", {
                expectedRevision: 0,
                connections: ["blue"],
              })).status,
              200,
            );
            const rejected = yield* request(
              tokenB,
              "/v1/execute",
              "POST",
              { code: "return 1", connections: ["red"] },
              "denied",
            );
            assert.equal(rejected.body.error, "MCP_CONNECTION_DENIED");
            assert.equal(red.counts().lists, 0);
            const admitted = yield* request(
              tokenA,
              "/v1/execute",
              "POST",
              intention,
              "frozen",
            );
            assert.equal(admitted.status, 202, JSON.stringify(admitted.body));
            saved = admitted.body.work.id;
            assert.equal(red.counts().writes, 0); // Discovery did not dispatch a business operation.
            yield* request(tokenA, "/v1/thread/tools", "PUT", {
              expectedRevision: 1,
              connections: ["blue"],
            });
            config.registry[0] = {
              ...config.registry[0]!,
              endpoint: blue.endpoint,
              revision: "v2",
            };
            yield* dispatch();
            const first = Schema.decodeUnknownSync(WorkSchema)(
              (yield* request(tokenA, `/v1/work/${saved}`)).body,
            );
            const result = (output(first) as CodeOutput).result as any;
            assert.isTrue(result.typed);
            assert.include(result.paths, "mcp.red.write");
            assert.isFalse(
              result.paths.some((x: string) => x.startsWith("mcp.blue.")),
            );
            assert.deepEqual(
              result.results.map((x: any) => [
                x.ok,
                x.data.label,
                x.data.value,
              ]),
              [
                [true, "red", 17],
                [true, "red", 11],
              ],
            );
            assert.equal(first.state.children.length, 0);
            assert.equal(first.calls, 2);
            assert.equal(red.counts().writes, 1);
            assert.equal(blue.counts().writes, 0);
            const changedCredential = new RemoteMcp(
              config,
              new Map([[credentialKey(refA), tokenB]]),
            );
            yield* Effect.promise(() =>
              rejects(
                changedCredential.invoke(
                  a,
                  first.tools!,
                  "mcp.red.write",
                  { amount: 91 },
                  defaultBounds,
                  Date.now() + 2000,
                  new AbortController().signal,
                ),
                /MCP_CREDENTIAL_VERSION_CHANGED/,
              ),
            );
            const before = red.counts().lists;
            assert.equal(
              (yield* request(
                tokenA,
                "/v1/execute",
                "POST",
                intention,
                "frozen",
              )).body.work.id,
              saved,
            );
            assert.equal(red.counts().lists, before);
            // Restore registry for new admissions; previous admitted Work is unchanged.
            config.registry[0] = {
              ...config.registry[0]!,
              endpoint: red.endpoint,
              revision: "v3",
            };
            const redirectConfig = {
              ...config,
              registry: [
                {
                  ...config.registry[0]!,
                  endpoint: red.endpoint.replace("/mcp", "/redirect"),
                },
              ],
            };
            const redirected = new RemoteMcp(
              redirectConfig,
              new Map([[credentialKey(refA), tokenA]]),
            );
            yield* Effect.promise(() =>
              rejects(
                redirected.freeze(a, ["red"], 0, "catalog", defaultBounds),
              ),
            );
            yield* Effect.promise(() =>
              rejects(
                changedCredential.freeze(
                  a,
                  ["red"],
                  0,
                  "catalog",
                  defaultBounds,
                ),
              ),
            );
            assert.equal(red.counts().lists, before); // Neither redirects nor wrong credentials can read a catalog.
            const run = Effect.fn(function* (
              token: string,
              code: string,
              key: string,
              connections?: string[],
            ) {
              const response = yield* request(
                token,
                "/v1/execute",
                "POST",
                { code, ...(connections ? { connections } : {}) },
                key,
              );
              assert.equal(response.status, 202, JSON.stringify(response.body));
              yield* dispatch();
              return Schema.decodeUnknownSync(WorkSchema)(
                (yield* request(token, `/v1/work/${response.body.work.id}`))
                  .body,
              );
            });
            const read =
              'const c=await tools.search({query:"read"});return {paths:c.items.map(x=>x.path),value:await tools[c.items[0].path]({})}';
            const replacement = (
              output(
                yield* run(tokenA, read, "replacement", ["red"]),
              ) as CodeOutput
            ).result as any;
            assert.deepEqual(replacement.paths, ["mcp.red.read"]);
            assert.equal(replacement.value.data.value, 17);
            const defaults = (
              output(yield* run(tokenA, read, "defaults")) as CodeOutput
            ).result as any;
            assert.deepEqual(defaults.paths, ["mcp.blue.read"]);
            assert.equal(defaults.value.data.value, 83);
            const other = (
              output(yield* run(tokenB, read, "defaults")) as CodeOutput
            ).result as any;
            assert.deepEqual(other, defaults);
            const none = (
              output(
                yield* run(
                  tokenA,
                  'return await tools.search({query:"read"})',
                  "empty",
                  [],
                ),
              ) as CodeOutput
            ).result as any;
            assert.deepEqual(none.items, []);
            const known = (
              output(
                yield* run(
                  tokenA,
                  "return await tools.mcp.red.known_error({})",
                  "known",
                  ["red"],
                ),
              ) as CodeOutput
            ).result as any;
            assert.equal(known.ok, false);
            assert.equal(known.error.code, "MCP_TOOL_ERROR");
            const invalid = (
              output(
                yield* run(
                  tokenA,
                  'return await tools.mcp.red.write({amount:"bad"})',
                  "invalid",
                  ["red"],
                ),
              ) as CodeOutput
            ).result as any;
            assert.isFalse(invalid.ok);
            assert.equal(red.counts().writes, 1);
            const untyped = (
              output(
                yield* run(
                  tokenA,
                  'return await tools.describe.tool({path:"mcp.red.no_schema"})',
                  "untyped",
                  ["red"],
                ),
              ) as CodeOutput
            ).result as any;
            assert.include(untyped.outputTypeScript, "unknown");
            const huge = yield* run(
              tokenA,
              "return await tools.mcp.red.huge({})",
              "bounded-response",
              ["red"],
            );
            assert.equal(huge.state.phase, "reconciling");
            const interaction = yield* run(
              tokenA,
              "try {await tools.mcp.red.interaction({})}catch{} return await tools.mcp.red.write({amount:99})",
              "interaction",
              ["red"],
            );
            assert.equal(interaction.state.phase, "reconciling");
            assert.equal(red.counts().interactions, 1);
            assert.equal(red.counts().writes, 1);
            const lost = yield* run(
              tokenA,
              "try {await tools.mcp.red.lost_write({})}catch{} return await tools.mcp.red.write({amount:99})",
              "lost",
              ["red"],
            );
            assert.equal(lost.state.phase, "reconciling");
            assert.equal(red.counts().writes, 2);
            const lostRetry = yield* request(
              tokenA,
              "/v1/execute",
              "POST",
              {
                code: "try {await tools.mcp.red.lost_write({})}catch{} return await tools.mcp.red.write({amount:99})",
                connections: ["red"],
              },
              "lost",
            );
            assert.equal(lostRetry.body.work.id, lost.id);
            assert.equal(red.counts().writes, 2);
            const count = yield* Effect.promise(() =>
              journal.transaction(
                async (tx) =>
                  (
                    await tx.sql.query<{ count: string }>(
                      "SELECT count(*) FROM work WHERE data->>'action'='connector.call' OR data->'call'->>'action'='connector.call'",
                    )
                  ).rows[0]?.count,
              ),
            );
            assert.equal(Number(count), 0);
          }).pipe(Effect.provide(layer())),
        );
        yield* Effect.gen(function* () {
          const manager = yield* WorkManager;
          const duplicate = yield* manager.execute(a, intention, "frozen");
          assert.equal(duplicate.work.id, saved);
          const work = yield* manager.inspect(a, saved);
          assert.equal(work.lease?.generation, 1);
          assert.equal((output(work) as CodeOutput).logs.length, 0);
          assert.equal(red.counts().writes, 2);
          assert.deepEqual((yield* manager.threadTools(a)).connections, [
            "blue",
          ]);
          assert.isNull(yield* manager.claim());
        }).pipe(Effect.provide(layer()));
      }),
    ),
  60_000,
);

it("SSRF policy rejects public-mode local/mapped/reserved addresses and permits only reviewed private ranges", () => {
  const base = {
    id: "company",
    revision: "v1",
    source: "company" as const,
    endpoint: "https://tools.example.com/mcp",
    privateCidrs: [] as string[],
  };
  const policy = endpointPolicy(base);
  for (const ip of [
    "127.0.0.1",
    "10.0.0.7",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "192.0.2.1",
  ])
    assert.throws(() => policy.allowed(ip));
  policy.allowed("8.8.8.8");
  for (const endpoint of [
    "file:///etc/passwd",
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp?token=secret",
  ])
    assert.throws(() => endpointPolicy({ ...base, endpoint }));
  const privatePolicy = endpointPolicy({
    ...base,
    privateCidrs: ["10.7.0.0/16"],
  });
  privatePolicy.allowed("10.7.3.9");
  assert.throws(() => privatePolicy.allowed("10.8.3.9"));
});
