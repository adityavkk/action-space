/** Opt-in destructive integration test, ONLY in a preapproved, labelled disposable namespace.
 * Does not install controllers, create namespaces or alter RBAC. Platform uses KUBECONFIG;
 * the separate harness identity only inspects test scope and deletes exact test-owned UIDs.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import { Config, Effect, Schedule, Schema } from "effect";
import {
  KubernetesBackend,
  kubernetesClient,
} from "../src/backends/kubernetes.js";
import { BridgeRegistry } from "../src/backends/cloudflare.js";
import {
  defaultBounds,
  type Auth,
  type Invocation,
  type Work,
} from "../src/domain.js";
import { serve } from "../src/http.js";
import { WorkJournal } from "../src/platform.js";
import { localCandidate, platformLayer } from "../src/runtime.js";
import {
  ActionOutputs,
  BoundSandbox,
  SandboxRef,
  Tree,
  WorkSchema,
} from "../src/schemas.js";
import { external } from "../src/effects.js";
import { hash } from "../src/util.js";

const api = {
  group: "agents.x-k8s.io",
  version: "v1beta1",
  plural: "sandboxes",
};
const run = Effect.gen(function* () {
  const namespace = yield* Config.string("ACTION_SPACE_LIVE_NAMESPACE");
  const testId = yield* Config.string("ACTION_SPACE_LIVE_TEST_ID");
  const adminPath = yield* Config.string("ACTION_SPACE_LIVE_ADMIN_KUBECONFIG");
  const image = yield* Config.string("ACTION_SPACE_LIVE_IMAGE");
  const runtimeClass = yield* Config.string("ACTION_SPACE_LIVE_RUNTIME_CLASS");
  const storageClass = yield* Config.string("ACTION_SPACE_LIVE_STORAGE_CLASS");
  assert.match(namespace, /^as-live-[a-z0-9-]+$/);
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  const admin = new k8s.KubeConfig();
  admin.loadFromFile(adminPath);
  const core = admin.makeApiClient(k8s.CoreV1Api);
  const objects = admin.makeApiClient(k8s.CustomObjectsApi);
  const ns = yield* external("Live.namespace", () =>
    core.readNamespace({ name: namespace }),
  );
  assert.equal(ns.metadata?.labels?.["action-space.dev/test-id"], testId);
  const runtime = yield* external("Live.runtimeClass", () =>
    admin.makeApiClient(k8s.NodeV1Api).readRuntimeClass({ name: runtimeClass }),
  );
  const version = yield* external("Live.version", () =>
    admin.makeApiClient(k8s.VersionApi).getCode(),
  );
  const discovery = yield* external("Live.discovery", () =>
    objects.getAPIResources({ group: api.group, version: api.version }),
  );
  assert(
    discovery.resources.some((r) => r.name === "sandboxes" && r.namespaced),
  );
  const control = new k8s.KubeConfig();
  control.loadFromDefault();
  const backend = new KubernetesBackend(
    {
      namespace,
      runtimeClass,
      storageClass,
      storage: "1Gi",
      readyTimeoutMs: 90_000,
    },
    kubernetesClient(control),
  );
  const ephemeral = backend.ephemeral();
  const persistent = backend.persistent();
  const registrations = [
    {
      candidate: {
        ...localCandidate(
          "kubernetes-ephemeral",
          { capability: "sandbox", lifecycle: "ephemeral" },
          ["sandbox-python-ephemeral-v1"],
        ),
        capacity: 1,
      },
      backend: {
        ...ephemeral,
        create: (r: Parameters<typeof ephemeral.create>[0]) =>
          ephemeral.create({ ...r, recipe: image }),
      },
    },
    {
      candidate: {
        ...localCandidate(
          "kubernetes-persistent",
          { capability: "sandbox", lifecycle: "persistent" },
          ["sandbox-linux-persistent-v1"],
        ),
        capacity: 1,
      },
      backend: {
        ...persistent,
        create: (r: Parameters<typeof persistent.create>[0]) =>
          persistent.create({ ...r, recipe: image }),
      },
    },
  ];
  const auth: Auth = {
    tenant: testId,
    actor: "live-test",
    thread: testId,
    grants: [
      "sandbox.run",
      "sandbox.shell",
      "sandbox.read",
      "context.manage",
      "resources.read",
      "resources.write",
    ],
    reviewer: false,
  };
  yield* external("Live.directory", () => mkdir(".data", { recursive: true }));
  const directory = yield* external("Live.privateJournal", () =>
    mkdtemp(resolve(".data/kubernetes-live-")),
  );
  const token = randomBytes(32).toString("hex");
  const layer = () =>
    platformLayer({
      directory,
      principals: [auth],
      registrations,
      settings: {
        bounds: { ...defaultBounds, wallMs: 120_000, cpuMs: 4000 },
        finalizationMs: 20_000,
      },
    });
  const owned = new Set<string>();
  const report: Record<string, unknown> = {
    testId,
    namespace,
    namespaceUid: ns.metadata?.uid,
    kubernetes: version.gitVersion,
    agentSandboxApi: `${api.group}/${api.version}`,
    runtimeClass,
    runtimeHandler: runtime.handler,
    image,
    journal: directory,
    checks: {},
    cleanup: "pending",
  };
  const checks = report.checks as Record<string, unknown>;
  let originalCall: Invocation | undefined;
  let originalId = "";
  const retained =
    "Action Space retained workspace\nαβγ\n" +
    Array.from({ length: 96 }, (_, i) => `${i}:${i * 17 - 5}`).join("\n");
  const poll = <A>(
    name: string,
    operation: () => Promise<A>,
    done: (a: A) => boolean,
  ) =>
    external(name, operation).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("250 millis"),
        while: (a) => !done(a),
      }),
      Effect.timeout("120 seconds"),
    );
  const sandboxObject = (operation: string) =>
    external("Live.sandbox", () =>
      objects.getNamespacedCustomObject({
        ...api,
        namespace,
        name: `as-${hash(operation).slice(0, 40)}`,
      }),
    );
  const snapshot = Effect.fn("Live.snapshot")(function* (operation: string) {
    const object = yield* sandboxObject(operation);
    const metadata = Schema.decodeUnknownSync(
      Schema.Struct({
        metadata: Schema.Struct({
          uid: Schema.String,
          name: Schema.String,
          generation: Schema.Number,
        }),
        status: Schema.Unknown,
      }),
    )(object);
    const pods = yield* external("Live.pods", () =>
      core.listNamespacedPod({ namespace }),
    );
    const ownedPods = pods.items.filter((p) =>
      p.metadata?.ownerReferences?.some((r) => r.uid === metadata.metadata.uid),
    );
    const pvcs = yield* external("Live.pvcs", () =>
      core.listNamespacedPersistentVolumeClaim({ namespace }),
    );
    return {
      sandbox: metadata,
      pods: ownedPods.map((p) => ({
        name: p.metadata?.name,
        uid: p.metadata?.uid,
        runtimeClass: p.spec?.runtimeClassName,
        phase: p.status?.phase,
        conditions: p.status?.conditions,
        containers: p.status?.containerStatuses?.map((c) => ({
          name: c.name,
          ready: c.ready,
          imageID: c.imageID,
        })),
      })),
      pvcs: pvcs.items
        .filter((p) =>
          p.metadata?.ownerReferences?.some(
            (r) => r.uid === metadata.metadata.uid,
          ),
        )
        .map((p) => ({
          name: p.metadata?.name,
          uid: p.metadata?.uid,
          volume: p.spec?.volumeName,
          phase: p.status?.phase,
        })),
    };
  });
  const session = Effect.fn("Live.httpSession")(function* (reconnect: boolean) {
    const http = yield* serve({
      port: 0,
      credentials: new Map([[token, auth]]),
      bridges: new BridgeRegistry(),
    });
    const request = (path: string, body?: unknown, key?: string) =>
      external("Live.HTTP", async () => {
        const response = await fetch(`http://127.0.0.1:${http.port}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        });
        const value: unknown = await response.json();
        assert(
          response.ok,
          `${path}: HTTP ${response.status} ${JSON.stringify(value)}`,
        );
        return value;
      });
    const observe = (id: string) =>
      request(`/v1/work/${id}?waitMs=10000`).pipe(
        Effect.map(Schema.decodeUnknownSync(WorkSchema)),
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          while: (w) =>
            ["queued", "running", "finalizing"].includes(w.state.phase),
        }),
        Effect.timeout("125 seconds"),
      );
    const completed = (w: Work) => {
      assert.equal(w.state.phase, "settled", JSON.stringify(w.state));
      if (w.state.phase !== "settled" || w.state.outcome.kind !== "completed")
        throw new Error(JSON.stringify(w.state));
      return w.state.outcome.output;
    };
    const submit = Effect.fn("Live.submit")(function* (
      call: Invocation,
      key: string,
    ) {
      const ref = Schema.decodeUnknownSync(
        Schema.Struct({ id: Schema.String }),
      )(yield* request("/v1/work", { call }, key));
      if (call.action === "sandbox.run") owned.add(ref.id);
      const work = yield* observe(ref.id);
      completed(work);
      return work;
    });
    if (reconnect) {
      assert(originalCall);
      const recovered = yield* submit(originalCall, "mutate-once");
      assert.equal(recovered.id, originalId);
      assert.equal(recovered.lease?.generation, 1);
      checks.reconnect = {
        workId: recovered.id,
        attempt: recovered.lease?.generation,
        sameWork: true,
      };
      return;
    }
    const code = Schema.decodeUnknownSync(Tree)(
      yield* request("/v1/resources", {
        "run.py": {
          base64: Buffer.from(
            'import pathlib,json\na=json.loads(pathlib.Path("/inputs/data/values.json").read_text())\npathlib.Path("/out/result.txt").write_text(str(sum(a)))\n',
          ).toString("base64"),
          executable: false,
        },
      }),
    );
    const inputs = Schema.decodeUnknownSync(Tree)(
      yield* request("/v1/resources", {
        "values.json": {
          base64: Buffer.from("[19,-7,31]").toString("base64"),
          executable: false,
        },
      }),
    );
    const finite = yield* submit(
      {
        action: "sandbox.run",
        version: "v1",
        target: null,
        input: {
          profile: "sandbox-python-ephemeral-v1",
          code,
          inputs: { data: inputs },
          argv: ["python3", "/code/run.py"],
          outputs: { required: ["result.txt"] },
        },
      },
      "finite",
    );
    const finiteOutput = Schema.decodeUnknownSync(ActionOutputs["sandbox.run"])(
      completed(finite),
    );
    const files = Schema.decodeUnknownSync(
      Schema.Record(
        Schema.String,
        Schema.Struct({ base64: Schema.String, executable: Schema.Boolean }),
      ),
    )(yield* request(`/v1/resources/${finiteOutput.files.id}`));
    assert.equal(
      Buffer.from(files["result.txt"]!.base64, "base64").toString(),
      "43",
    );
    assert.equal(
      finite.placement?.chosen?.candidate.id,
      "kubernetes-ephemeral",
    );
    const journal = yield* WorkJournal;
    const allocation = yield* external("Live.allocationReceipt", () =>
      journal.transaction((tx) =>
        tx.sql.query<{ allocation: unknown }>(
          "SELECT allocation FROM job_allocation WHERE work_id=$1",
          [finite.id],
        ),
      ),
    );
    checks.ephemeral = {
      workId: finite.id,
      output: "43",
      files: finiteOutput.files,
      allocation: allocation.rows[0]?.allocation,
      placement: finite.placement,
    };
    yield* poll(
      "Live.ephemeralDeleted",
      async () => {
        try {
          await objects.getNamespacedCustomObject({
            ...api,
            namespace,
            name: `as-${hash(finite.id).slice(0, 40)}`,
          });
          return false;
        } catch (error) {
          if (error instanceof k8s.ApiException && error.code === 404)
            return true;
          throw error;
        }
      },
      Boolean,
    );
    checks.ephemeralCleanup = "Sandbox and owned Pod deleted by platform";
    const ensure = yield* submit(
      {
        action: "context.ensure",
        version: "v1",
        target: null,
        input: {
          owner: auth.thread,
          name: "retained-test",
          spec: {
            profile: "sandbox-linux-persistent-v1",
            seed: code,
            idleMs: 600_000,
          },
        },
      },
      "ensure",
    );
    const context = Schema.decodeUnknownSync(SandboxRef)(completed(ensure));
    owned.add(context.id);
    const binding = Schema.decodeUnknownSync(BoundSandbox)(
      yield* request(
        "/v1/binding",
        { context, expectedRevision: null },
        "bind",
      ),
    );
    originalCall = {
      action: "sandbox.shell",
      version: "v1",
      target: binding,
      input: {
        command: `printf '%s' '${Buffer.from(retained).toString("base64")}' | base64 -d > state.txt; printf '%s\\n' mutation >> mutations.txt; printf volatile > /tmp/not-retained`,
        cwd: "/workspace",
      },
    };
    const mutation = yield* submit(originalCall, "mutate-once");
    assert.equal(
      Schema.decodeUnknownSync(ActionOutputs["sandbox.shell"])(
        completed(mutation),
      ).exitCode,
      0,
    );
    originalId = mutation.id;
    const before = yield* snapshot(context.id);
    assert.equal(before.pods.length, 1);
    assert.equal(before.pods[0]?.runtimeClass, runtimeClass);
    assert.equal(before.pvcs.length, 1);
    assert.equal(before.pvcs[0]?.phase, "Bound");
    checks.before = before;
    yield* submit(
      { action: "context.sleep", version: "v1", target: context, input: {} },
      "sleep",
    );
    const sleeping = yield* snapshot(context.id);
    assert.equal(sleeping.pods.length, 0);
    assert.equal(sleeping.pvcs[0]?.uid, before.pvcs[0]?.uid);
    checks.suspended = sleeping;
    const wake = yield* submit(
      { action: "context.wake", version: "v1", target: context, input: {} },
      "wake",
    );
    const after = yield* snapshot(context.id);
    assert.equal(after.sandbox.metadata.uid, before.sandbox.metadata.uid);
    assert.notEqual(after.pods[0]?.uid, before.pods[0]?.uid);
    assert.equal(after.pvcs[0]?.uid, before.pvcs[0]?.uid);
    assert.equal(after.pods.length, 1);
    checks.awake = { ...after, continuity: completed(wake) };
    const duplicate = yield* submit(originalCall, "mutate-once");
    assert.equal(duplicate.id, mutation.id);
    assert.equal(duplicate.lease?.generation, 1);
    const read = yield* submit(
      {
        action: "sandbox.read",
        version: "v1",
        target: binding,
        input: { path: "/workspace/state.txt" },
      },
      "read",
    );
    assert.equal(
      Schema.decodeUnknownSync(ActionOutputs["sandbox.read"])(completed(read))
        .text,
      retained,
    );
    const proof = yield* submit(
      {
        action: "sandbox.shell",
        version: "v1",
        target: binding,
        input: {
          command: "cat mutations.txt; test ! -e /tmp/not-retained",
          cwd: "/workspace",
        },
      },
      "proof",
    );
    const result = Schema.decodeUnknownSync(ActionOutputs["sandbox.shell"])(
      completed(proof),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "mutation\n");
    checks.retention = {
      bytes: Buffer.byteLength(retained),
      sha256: hash(retained),
      exactRead: true,
      originalWork: mutation.id,
      duplicateWork: duplicate.id,
      duplicateAttempt: duplicate.lease?.generation,
      mutationCount: 1,
      volatileRootDiscarded: true,
      workerReady:
        "actual native write/read commands succeeded independently of Pod readiness",
    };
  });
  yield* Effect.scoped(session(false).pipe(Effect.provide(layer()))).pipe(
    Effect.andThen(Effect.scoped(session(true).pipe(Effect.provide(layer())))),
    Effect.tap(() =>
      Effect.sync(() => {
        report.result = "passed";
      }),
    ),
    Effect.ensuring(
      Effect.gen(function* () {
        const remaining: string[] = [];
        const deletedUids = new Set<string>();
        for (const operation of owned) {
          const name = `as-${hash(operation).slice(0, 40)}`;
          yield* external("Live.cleanupOwned", async () => {
            try {
              const object = Schema.decodeUnknownSync(
                Schema.Struct({
                  metadata: Schema.Struct({
                    uid: Schema.String,
                    annotations: Schema.Record(Schema.String, Schema.String),
                  }),
                }),
              )(
                await objects.getNamespacedCustomObject({
                  ...api,
                  namespace,
                  name,
                }),
              );
              assert.equal(
                object.metadata.annotations["action-space.dev/operation"],
                operation,
              );
              deletedUids.add(object.metadata.uid);
              await objects.deleteNamespacedCustomObject({
                ...api,
                namespace,
                name,
                body: {
                  preconditions: { uid: object.metadata.uid },
                  propagationPolicy: "Foreground",
                },
              });
            } catch (error) {
              if (!(error instanceof k8s.ApiException && error.code === 404))
                throw error;
            }
          }).pipe(
            Effect.andThen(
              poll(
                "Live.deletionObserved",
                async () => {
                  try {
                    await objects.getNamespacedCustomObject({
                      ...api,
                      namespace,
                      name,
                    });
                    return false;
                  } catch (error) {
                    if (error instanceof k8s.ApiException && error.code === 404)
                      return true;
                    throw error;
                  }
                },
                Boolean,
              ),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                remaining.push(name);
              }),
            ),
          );
        }
        yield* poll(
          "Live.dependentsDeleted",
          async () => {
            const [pods, pvcs] = await Promise.all([
              core.listNamespacedPod({ namespace }),
              core.listNamespacedPersistentVolumeClaim({ namespace }),
            ]);
            return [...pods.items, ...pvcs.items].every(
              (item) =>
                !item.metadata?.ownerReferences?.some((owner) =>
                  deletedUids.has(owner.uid),
                ),
            );
          },
          Boolean,
        ).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              remaining.push("owned Pod/PVC cleanup not confirmed");
            }),
          ),
        );
        report.cleanup = {
          requestedExactOwnedDeletion: owned.size,
          errors: remaining,
          observedComplete: remaining.length === 0,
        };
        if (remaining.length) report.result = "failed_cleanup";
        yield* external("Live.report", async () => {
          await mkdir(".amp/in/artifacts", { recursive: true });
          await writeFile(
            ".amp/in/artifacts/kubernetes-live.json",
            JSON.stringify(report, null, 2),
            { mode: 0o600 },
          );
        });
        assert.equal(
          remaining.length,
          0,
          "Test-owned resources still require cleanup",
        );
      }).pipe(Effect.orDie),
    ),
  );
  yield* Effect.logInfo("Live Kubernetes journeys passed", {
    report: ".amp/in/artifacts/kubernetes-live.json",
    journal: directory,
  });
});
Effect.runPromise(run).catch(() => {
  console.error(
    "Live Kubernetes integration failed. Inspect scoped Work evidence and test-owned cluster resources; credentials were not logged.",
  );
  process.exitCode = 1;
});
