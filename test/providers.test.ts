import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiException } from "@kubernetes/client-node";
import { ConfigProvider, Effect } from "effect";
import { loadConfiguration } from "../src/configuration.js";
import { WorkManager } from "../src/platform.js";
import { fixture, output } from "./fixture.js";
import {
  E2BBackend,
  type E2BClient,
  type E2BSession,
} from "../src/backends/e2b.js";
import {
  KubernetesBackend,
  type KubernetesClient,
} from "../src/backends/kubernetes.js";
import {
  BridgeRegistry,
  CloudflareBackend,
} from "../src/backends/cloudflare.js";
import { defaultBounds, Interrupt } from "../src/domain.js";
import type { CodeRequest } from "../src/backends/contracts.js";
import { controllerSource } from "../src/backends/native-controller.js";

// Only the Worker entrypoint base is doubled; the gateway module builder is real.
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

it.live("reinitializes retained workload-owned roots without CAP_FOWNER", () =>
  Effect.promise(async () => {
    // Execute the real Python controller with a filesystem permission model; CI needs no root.
    // This specifically reproduces the live runc wake failure, rather than granting more capability.
    const { stdout } = await promisify(execFile)("python3", [
      "-c",
      `
import io,os,sys
from unittest.mock import patch
owners={'/workspace':2000}
modes={}
def mkdir(p,exist_ok): owners.setdefault(p,0)
def chown(p,u,g): owners[p]=u
def chmod(p,m):
    if owners[p]!=0: raise PermissionError('CAP_FOWNER not granted')
    modes[p]=m
with patch('sys.stdin',io.StringIO('{"op":"initialize"}')),patch('os.makedirs',mkdir),patch('os.chown',chown),patch('os.chmod',chmod):
    exec(sys.argv[1])
assert owners == {'/workspace':2000,'/code':0,'/inputs':0,'/out':2000,'/scratch':2000}
assert set(modes.values()) == {0o755}
print('retained-root-ready')
`,
      controllerSource,
    ]);
    assert.include(stdout, "retained-root-ready");
  }),
);

it.live(
  "runs the standalone QuickJS configuration without native adapters or cloud credentials",
  () =>
    Effect.gen(function* () {
      const config = yield* loadConfiguration().pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ACTION_SPACE_CONFIG: "config/quickjs.json",
              ACTION_SPACE_TOKEN: "configuration-test-token-not-a-real-secret",
            }),
          ),
        ),
      );
      assert.deepEqual(
        config.registrations.map((x) => [
          x.candidate.id,
          x.backend.capability,
          x.backend.lifecycle,
        ]),
        [["quickjs", "code_execution", "invocation"]],
      );
      const auth = config.principals[0];
      if (!auth) throw new Error("missing principal");
      yield* fixture(
        Effect.gen(function* () {
          const manager = yield* WorkManager;
          const ref = yield* manager.execute(
            auth,
            { code: "return await tools.data.sum({values:[13,-4]})" },
            "configured-quickjs",
          );
          assert.deepEqual(
            output(yield* manager.inspect(auth, ref.work.id, 10000)),
            { result: { ok: true, data: { sum: 9 } }, logs: [], artifacts: [] },
          );
        }),
        { registrations: config.registrations, principals: config.principals },
      );
    }),
);

describe("provider SDK contract doubles — no live cloud resources", () => {
  it.live(
    "Cloudflare rejects an Executor MCP catalog before contacting the gateway",
    () =>
      Effect.gen(function* () {
        let contacted = false;
        const backend = new CloudflareBackend(
          {
            gatewayUrl: "https://gateway.test",
            gatewayToken: "test-only",
            brokerUrl: "https://control.test",
          },
          new BridgeRegistry(),
          async () => {
            contacted = true;
            throw new Error("must not dispatch");
          },
        );
        const error = yield* backend
          .execute({
            code: "return await tools.mcp.customer.write({})",
            tools: [
              {
                path: "mcp.customer.write",
                description: "write",
                inputSchema: { type: "object" },
              },
            ],
            bounds: defaultBounds,
            deadline: Date.now() + 10000,
            signal: new AbortController().signal,
            bridge: async () => null,
            log: async () => {},
          })
          .pipe(Effect.flip);
        assert.equal(error._tag, "Fault");
        assert.equal(
          error instanceof Error && "code" in error && error.code,
          "UNSUPPORTED_CODE_PROFILE",
        );
        assert.isFalse(contacted);
      }),
  );
  it.live(
    "Cloudflare gives source its own module, never the raw broker's lexical scope",
    () =>
      Effect.gen(function* () {
        const { workerCode } = yield* Effect.promise(
          () => import("../providers/cloudflare/worker.js"),
        );
        const program =
          "(async function(){ return [typeof env, typeof sequence, typeof surface]; })()";
        const plan = workerCode({ program, bounds: defaultBounds }, {});
        assert.include(plan.modules["program.js"], program);
        assert.notInclude(plan.modules["agent.js"], program);
        assert.include(
          plan.modules["agent.js"],
          "program(surface.tools, surface.console)",
        );
        assert.equal(plan.globalOutbound, null);
        assert.deepEqual(Object.keys(plan.env), ["BROKER"]);
      }),
  );
  it.live(
    "E2B creates offline, uses stdin command handles, disk-only pauses, reboots and releases",
    () =>
      Effect.gen(function* () {
        const events: Array<{ name: string; args: unknown }> = [];
        let state: "running" | "paused" = "running";
        let input = "";
        const session: E2BSession = {
          sandboxId: "sandbox-123",
          commands: {
            run: async (command, options) => {
              events.push({ name: "run", args: { command, options } });
              return {
                sendStdin: async (value) => {
                  input =
                    typeof value === "string"
                      ? value
                      : Buffer.from(value).toString();
                },
                closeStdin: async () => {},
                kill: async () => true,
                wait: async () => ({
                  exitCode: 0,
                  stdout:
                    JSON.parse(input).op === "run"
                      ? '{"exitCode":0,"stdout":"native-7","stderr":""}'
                      : "{}",
                  stderr: "",
                }),
              };
            },
          },
          pause: async (options) => {
            events.push({ name: "pause", args: options });
            state = "paused";
            return true;
          },
        };
        const client: E2BClient = {
          create: async (template, options) => {
            events.push({ name: "create", args: { template, options } });
            return session;
          },
          connect: async (id, options) => {
            events.push({ name: "connect", args: { id, options } });
            state = "running";
            return session;
          },
          getInfo: async () => ({ sandboxId: session.sandboxId, state }),
          kill: async (id) => {
            events.push({ name: "kill", args: id });
            return true;
          },
        };
        const backend = new E2BBackend(
          { apiKey: "test-only", timeoutMs: 60_000 },
          client,
        );
        const allocation = yield* backend.create({
          operation: "work-7",
          recipe: "reviewed-template",
          generation: 1,
          bounds: defaultBounds,
        });
        yield* backend.io.initialize(allocation);
        assert.equal(allocation.id, "sandbox-123");
        assert.deepInclude(events[0]?.args, { template: "reviewed-template" });
        assert.include(
          JSON.stringify(events[0]),
          '"allowInternetAccess":false',
        );
        assert.deepEqual(
          yield* backend.io.run(allocation, {
            argv: ["python3", "/code/job.py"],
            cwd: "/scratch",
            bounds: defaultBounds,
            deadline: Date.now() + 10_000,
            signal: new AbortController().signal,
          }),
          { exitCode: 0, stdout: "native-7", stderr: "" },
        );
        yield* backend.park(allocation);
        assert.equal(state, "paused");
        assert.deepEqual(events.find((x) => x.name === "pause")?.args, {
          keepMemory: false,
        });
        assert.equal((yield* backend.wake(allocation, 2)).generation, 2);
        assert.include(
          JSON.stringify(events.filter((x) => x.name === "connect").at(-1)),
          '"onResume":"reboot"',
        );
        yield* backend.release(allocation);
        assert.deepEqual(events.at(-1), { name: "kill", args: "sandbox-123" });
      }),
  );
  it.live(
    "E2B ambiguous create is uncertain and is never retried automatically",
    () =>
      Effect.gen(function* () {
        let creates = 0;
        const client: E2BClient = {
          create: async () => {
            creates++;
            throw new Error("connection dropped after allocation");
          },
          connect: async () => {
            throw new Error("unexpected");
          },
          getInfo: async () => {
            throw new Error("unexpected");
          },
          kill: async () => false,
        };
        const result = yield* new E2BBackend(
          { apiKey: "test-only", timeoutMs: 60_000 },
          client,
        )
          .create({
            operation: "w",
            recipe: "template",
            generation: 1,
            bounds: defaultBounds,
          })
          .pipe(Effect.flip);
        assert.equal(result._tag, "Uncertain");
        assert.equal(creates, 1);
      }),
  );
  it.live(
    "Agent Sandbox parks the exact UID, preserves its PVC, remounts at a new generation, and only deletes ephemeral Sandboxes",
    () =>
      Effect.gen(function* () {
        let mode = "Running";
        let generation = 1;
        let operation = "";
        let body: object = {};
        const patches: object[][] = [];
        const deleted: string[] = [];
        const operations: string[] = [];
        const object = () => ({
          metadata: {
            name: "sandbox",
            uid: "uid-original",
            generation,
            annotations: { "action-space.dev/operation": operation },
          },
          spec: { operatingMode: mode },
          status: {
            conditions: [
              {
                type: mode === "Running" ? "Ready" : "Suspended",
                status: "True",
                reason: mode === "Running" ? "Ready" : "PodTerminated",
                observedGeneration: generation,
              },
            ],
          },
        });
        const client: KubernetesClient = {
          create: async (_namespace, manifest) => {
            body = manifest;
            return object();
          },
          get: async () => object(),
          patch: async (_namespace, _name, ops) => {
            patches.push(ops);
            mode = JSON.stringify(ops).includes("Suspended")
              ? "Suspended"
              : "Running";
            generation++;
            return object();
          },
          delete: async (_namespace, _name, uid) => {
            deleted.push(uid);
          },
          exec: async (_namespace, _name, _uid, _argv, stdin) => {
            operations.push(JSON.parse(stdin).op);
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        };
        const backend = new KubernetesBackend(
          {
            namespace: "action-space",
            runtimeClass: "kata-qualified-by-operator",
            storageClass: "retained",
            storage: "2Gi",
            readyTimeoutMs: 1000,
          },
          client,
        );
        operation = "persistent-1";
        const allocation = yield* backend.createFor("persistent")({
          operation,
          recipe: "image@sha256:reviewed",
          generation: 1,
          bounds: defaultBounds,
        });
        yield* backend.initialize(allocation);
        const manifest = JSON.stringify(body);
        assert.include(manifest, "volumeClaimTemplates");
        assert.notInclude(manifest, '"volumes"');
        assert.notInclude(manifest, "SandboxClaim");
        assert.include(manifest, '"automountServiceAccountToken":false');
        yield* backend.park(allocation);
        assert.equal(mode, "Suspended");
        assert.equal(deleted.length, 0);
        assert.deepEqual(patches[0]?.[0], {
          op: "test",
          path: "/metadata/uid",
          value: "uid-original",
        });
        assert.equal((yield* backend.wake(allocation, 2)).generation, 2);
        assert.deepEqual(operations, ["initialize", "quiesce", "initialize"]);
        assert.equal(
          (yield* backend.release(allocation).pipe(Effect.flip))._tag,
          "Fault",
        );
        operation = "ephemeral-1";
        const ephemeral = yield* backend.createFor("ephemeral")({
          operation,
          recipe: "image",
          generation: 1,
          bounds: defaultBounds,
        });
        assert.notInclude(JSON.stringify(body), "volumeClaimTemplates");
        assert.include(JSON.stringify(body), "emptyDir");
        yield* backend.release(ephemeral);
        assert.deepEqual(deleted, ["uid-original"]);
      }),
  );
  it.live(
    "Agent Sandbox rejects stale Ready evidence and treats only delete404 as already released",
    () =>
      Effect.gen(function* () {
        let executions = 0;
        let deleteStatus = 404;
        const object = {
          metadata: {
            name: "sandbox",
            uid: "uid-1",
            generation: 2,
            annotations: {},
          },
          spec: { operatingMode: "Running" },
          status: {
            conditions: [
              { type: "Ready", status: "True", observedGeneration: 1 },
            ],
          },
        };
        const client: KubernetesClient = {
          create: async () => object,
          get: async () => object,
          patch: async () => object,
          exec: async () => {
            executions++;
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
          delete: async () => {
            throw new ApiException(
              deleteStatus,
              "test provider response",
              {},
              {},
            );
          },
        };
        const backend = new KubernetesBackend(
          {
            namespace: "local-test",
            runtimeClass: "test",
            storageClass: "test",
            storage: "1Gi",
            readyTimeoutMs: 25,
          },
          client,
        );
        const allocation = {
          provider: "kubernetes",
          id: "sandbox",
          generation: 1,
          data: { uid: "uid-1", lifecycle: "ephemeral" },
        };
        assert.equal(
          (yield* backend.initialize(allocation).pipe(Effect.flip))._tag,
          "Uncertain",
        );
        assert.equal(executions, 0);
        yield* backend.release(allocation);
        deleteStatus = 409;
        assert.equal(
          (yield* backend.release(allocation).pipe(Effect.flip))._tag,
          "Fault",
        );
      }),
  );
  it.live(
    "Cloudflare uses our authenticated deployed gateway and revokes the broker channel on return",
    () =>
      Effect.gen(function* () {
        const registry = new BridgeRegistry();
        const seen: string[] = [];
        let token = "";
        const request: CodeRequest = {
          code: "return await tools.data.sum({values:[3,8]})",
          bounds: defaultBounds,
          deadline: Date.now() + 10_000,
          signal: new AbortController().signal,
          bridge: async (path, args, id) => {
            seen.push(`${path}/${id}`);
            return { ok: true, data: 11 };
          },
          log: async () => {},
        };
        const fetcher: typeof fetch = async (_url, options) => {
          assert.equal(
            new Headers(options?.headers).get("authorization"),
            "Bearer gateway-secret",
          );
          const body = JSON.parse(String(options?.body));
          token = body.channel;
          assert.equal(
            body.brokerUrl,
            "https://control.test/internal/code-callback",
          );
          const result = await Effect.runPromise(
            registry.handle(token, {
              kind: "call",
              requestId: "0",
              path: "data.sum",
              input: { values: [3, 8] },
            }),
          );
          return Response.json({ result, logs: [], artifacts: [] });
        };
        const backend = new CloudflareBackend(
          {
            gatewayUrl: "https://gateway.test/",
            gatewayToken: "gateway-secret",
            brokerUrl: "https://control.test/internal/code-callback",
          },
          registry,
          fetcher,
        );
        assert.deepEqual((yield* backend.execute(request)).result, {
          ok: true,
          data: 11,
        });
        assert.deepEqual(seen, ["data.sum/0"]);
        assert.equal(
          (yield* registry
            .handle(token, {
              kind: "call",
              requestId: "1",
              path: "data.sum",
              input: {},
            })
            .pipe(Effect.flip))._tag,
          "Fault",
        );
      }),
  );
  it.live(
    "a Cloudflare guest cannot catch approval and turn the parent into success",
    () =>
      Effect.gen(function* () {
        const registry = new BridgeRegistry();
        const backend = new CloudflareBackend(
          {
            gatewayUrl: "https://gateway.test",
            gatewayToken: "secret",
            brokerUrl: "https://control.test",
          },
          registry,
          async (_url, options) => {
            const body = JSON.parse(String(options?.body));
            await Effect.runPromise(
              registry.handle(body.channel, {
                kind: "call",
                requestId: "0",
                path: "write.tool",
                input: {},
              }),
            ).catch(() => {});
            return Response.json({
              result: "guest claims success",
              logs: [],
              artifacts: [],
            });
          },
        );
        const result = yield* backend
          .execute({
            code: "return 1",
            bounds: defaultBounds,
            deadline: Date.now() + 10_000,
            signal: new AbortController().signal,
            bridge: async () => {
              throw new Interrupt("approval");
            },
            log: async () => {},
          })
          .pipe(Effect.flip);
        assert.deepEqual(result, new Interrupt("approval"));
      }),
  );
});
