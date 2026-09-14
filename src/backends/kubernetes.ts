import * as k8s from "@kubernetes/client-node";
import { Readable, Writable } from "node:stream";
import { Effect, Schedule, Schema } from "effect";
import {
  Fault,
  Uncertain,
  type Allocation,
  type ProcessOutput,
} from "../domain.js";
import { external } from "../effects.js";
import { hash } from "../util.js";
import { RemoteNativeIO, type NativeTransport } from "./native-controller.js";
import type {
  EphemeralSandboxBackend,
  NativeRequest,
  PersistentSandboxBackend,
} from "./contracts.js";

const SandboxObject = Schema.Struct({
  metadata: Schema.Struct({
    name: Schema.String,
    uid: Schema.String,
    generation: Schema.Number,
    annotations: Schema.Record(Schema.String, Schema.String),
  }),
  spec: Schema.Struct({
    operatingMode: Schema.Literals(["Running", "Suspended"]),
  }),
  status: Schema.optionalKey(
    Schema.Struct({
      conditions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            status: Schema.String,
            reason: Schema.optionalKey(Schema.String),
            observedGeneration: Schema.Number,
          }),
        ),
      ),
    }),
  ),
});
export type SandboxObject = typeof SandboxObject.Type;
export interface KubernetesClient {
  create(namespace: string, body: object): Promise<unknown>;
  get(namespace: string, name: string): Promise<unknown>;
  patch(
    namespace: string,
    name: string,
    operations: object[],
  ): Promise<unknown>;
  delete(namespace: string, name: string, uid: string): Promise<void>;
  exec(
    namespace: string,
    name: string,
    uid: string,
    argv: string[],
    stdin: string,
    timeoutMs: number,
    outputBytes: number,
    signal: AbortSignal,
  ): Promise<ProcessOutput>;
}
const api = {
  group: "agents.x-k8s.io",
  version: "v1beta1",
  plural: "sandboxes",
};
export function kubernetesClient(config: k8s.KubeConfig): KubernetesClient {
  const objects = config.makeApiClient(k8s.CustomObjectsApi);
  const pods = config.makeApiClient(k8s.CoreV1Api);
  const exec = new k8s.Exec(config);
  return {
    create: (namespace, body) =>
      objects.createNamespacedCustomObject({ ...api, namespace, body }),
    get: (namespace, name) =>
      objects.getNamespacedCustomObject({ ...api, namespace, name }),
    patch: (namespace, name, body) =>
      objects.patchNamespacedCustomObject({ ...api, namespace, name, body }),
    delete: async (namespace, name, uid) => {
      await objects.deleteNamespacedCustomObject({
        ...api,
        namespace,
        name,
        body: { preconditions: { uid }, propagationPolicy: "Foreground" },
      });
    },
    exec: async (
      namespace,
      name,
      uid,
      argv,
      input,
      timeoutMs,
      outputBytes,
      signal,
    ) => {
      const list = await pods.listNamespacedPod({ namespace });
      const owned = list.items.filter((p) =>
        p.metadata?.ownerReferences?.some((r) => r.uid === uid && r.controller),
      );
      const pod = owned[0];
      if (
        owned.length !== 1 ||
        !pod?.metadata?.name ||
        pod.metadata.deletionTimestamp
      )
        throw new Uncertain(
          "Expected one live Pod owned by the exact Sandbox UID",
        );
      const podName = pod.metadata.name;
      return new Promise<ProcessOutput>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let settled = false;
        let socket: Awaited<ReturnType<k8s.Exec["exec"]>> | undefined;
        const finish = (error: unknown, result?: ProcessOutput) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          socket?.close();
          if (error) reject(error);
          else if (result) resolve(result);
        };
        const abort = () =>
          finish(
            new Uncertain(
              "Kubernetes exec transport aborted; remote process stop is not proven",
            ),
          );
        const timer = setTimeout(abort, timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        const stream = (append: (chunk: string) => void) =>
          new Writable({
            write(chunk: Buffer, _encoding, callback) {
              bytes += chunk.length;
              if (bytes > outputBytes) abort();
              else append(chunk.toString());
              callback();
            },
          });
        void exec
          .exec(
            namespace,
            podName,
            "runtime",
            argv,
            stream((s) => {
              stdout += s;
            }),
            stream((s) => {
              stderr += s;
            }),
            Readable.from([input]),
            false,
            (status) => {
              const exit = status.details?.causes?.find(
                (x) => x.reason === "ExitCode",
              )?.message;
              if (status.status !== "Success" && exit === undefined) {
                finish(
                  new Uncertain("Kubernetes process exit evidence missing"),
                );
                return;
              }
              finish(null, {
                exitCode: exit === undefined ? 0 : Number(exit),
                stdout,
                stderr,
              });
            },
          )
          .then((ws) => {
            socket = ws;
            if (settled) ws.close();
            else {
              ws.on("error", abort);
              ws.on("close", () => {
                if (!settled) abort();
              });
            }
          }, abort);
        if (signal.aborted) abort();
      });
    },
  };
}
export class KubernetesBackend {
  readonly io: RemoteNativeIO;
  constructor(
    readonly config: {
      namespace: string;
      runtimeClass: string;
      storageClass: string;
      storage: string;
      readyTimeoutMs: number;
    },
    readonly client: KubernetesClient,
  ) {
    const transport: NativeTransport = {
      execute: (a, argv, stdin, timeoutMs, outputBytes, signal) => {
        const uid = a.data.uid;
        if (!uid) return Promise.reject(new Fault("MISSING_PROVIDER_IDENTITY"));
        return client.exec(
          config.namespace,
          a.id,
          uid,
          argv,
          stdin,
          timeoutMs,
          outputBytes,
          signal,
        );
      },
    };
    this.io = new RemoteNativeIO(transport);
  }
  manifest(
    request: NativeRequest,
    lifecycle: "ephemeral" | "persistent",
  ): object {
    const name = `as-${hash(request.operation).slice(0, 40)}`;
    return {
      apiVersion: `${api.group}/${api.version}`,
      kind: "Sandbox",
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: {
          "app.kubernetes.io/managed-by": "action-space",
          "action-space.dev/lifecycle": lifecycle,
        },
        annotations: { "action-space.dev/operation": request.operation },
      },
      spec: {
        operatingMode: "Running",
        service: false,
        podTemplate: {
          spec: {
            runtimeClassName: this.config.runtimeClass,
            automountServiceAccountToken: false,
            restartPolicy: "OnFailure",
            containers: [
              {
                name: "runtime",
                image: request.recipe,
                command: ["sleep", "infinity"],
                resources: {
                  requests: { cpu: "100m", memory: "128Mi" },
                  limits: {
                    cpu: "1",
                    memory: `${Math.max(128, Math.ceil(request.bounds.heapBytes / 1048576) + 64)}Mi`,
                  },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: {
                    drop: ["ALL"],
                    add: ["CHOWN", "SETUID", "SETGID", "KILL", "DAC_OVERRIDE"],
                  },
                  seccompProfile: { type: "RuntimeDefault" },
                },
                volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              },
            ],
            ...(lifecycle === "ephemeral"
              ? {
                  volumes: [
                    {
                      name: "workspace",
                      emptyDir: { sizeLimit: this.config.storage },
                    },
                  ],
                }
              : {}),
          },
        },
        ...(lifecycle === "persistent"
          ? {
              volumeClaimTemplates: [
                {
                  metadata: { name: "workspace" },
                  spec: {
                    accessModes: ["ReadWriteOnce"],
                    storageClassName: this.config.storageClass,
                    resources: { requests: { storage: this.config.storage } },
                  },
                },
              ],
            }
          : {}),
      },
    };
  }
  private object = Effect.fn("Kubernetes.get")(
    function* (this: KubernetesBackend, name: string) {
      return yield* Schema.decodeUnknownEffect(SandboxObject)(
        yield* external("Kubernetes.getSandbox", () =>
          this.client.get(this.config.namespace, name),
        ),
      ).pipe(Effect.mapError(() => new Fault("INVALID_SANDBOX_RESPONSE")));
    }.bind(this),
  );
  private wait = Effect.fn("Kubernetes.wait")(
    function* (
      this: KubernetesBackend,
      name: string,
      uid: string,
      mode: "Running" | "Suspended",
    ) {
      const ready = (object: SandboxObject) =>
        object.spec.operatingMode === mode &&
        object.status?.conditions?.some(
          (c) =>
            c.type === (mode === "Running" ? "Ready" : "Suspended") &&
            c.status === "True" &&
            c.observedGeneration === object.metadata.generation &&
            (mode === "Running" || c.reason === "PodTerminated"),
        );
      return yield* this.object(name).pipe(
        Effect.tap((object) =>
          object.metadata.uid === uid
            ? Effect.void
            : Effect.fail(
                new Uncertain("Sandbox UID changed; old executor not fenced"),
              ),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          while: (object) => !ready(object),
        }),
        Effect.timeout(this.config.readyTimeoutMs),
        Effect.mapError(
          () =>
            new Uncertain(
              `Sandbox ${mode} not confirmed at current generation`,
            ),
        ),
      );
    }.bind(this),
  );
  createFor = (lifecycle: "ephemeral" | "persistent") =>
    Effect.fn(`Kubernetes.create.${lifecycle}`)(
      function* (this: KubernetesBackend, request: NativeRequest) {
        const name = `as-${hash(request.operation).slice(0, 40)}`;
        const response = yield* external(
          "Kubernetes.createSandbox",
          async () => {
            try {
              return await this.client.create(
                this.config.namespace,
                this.manifest(request, lifecycle),
              );
            } catch {
              return this.client.get(this.config.namespace, name).catch(() => {
                throw new Uncertain(
                  "Sandbox create unresolved; inspect stable operation name before retry",
                );
              });
            }
          },
        );
        const object = yield* Schema.decodeUnknownEffect(SandboxObject)(
          response,
        ).pipe(
          Effect.mapError(
            () => new Uncertain("Create response lacks Sandbox identity"),
          ),
        );
        if (
          object.metadata.annotations["action-space.dev/operation"] !==
          request.operation
        )
          return yield* new Fault("PROVIDER_OWNERSHIP_CONFLICT");
        const allocation: Allocation = {
          provider: "kubernetes",
          id: name,
          generation: request.generation,
          data: {
            uid: object.metadata.uid,
            namespace: this.config.namespace,
            lifecycle,
          },
        };
        return allocation;
      }.bind(this),
    );
  initialize = Effect.fn("Kubernetes.initialize")(
    function* (this: KubernetesBackend, a: Allocation) {
      if (!a.data.uid) return yield* new Fault("MISSING_PROVIDER_IDENTITY");
      yield* this.wait(a.id, a.data.uid, "Running");
      yield* this.io.initialize(a);
    }.bind(this),
  );
  private mode = Effect.fn("Kubernetes.operatingMode")(
    function* (
      this: KubernetesBackend,
      a: Allocation,
      mode: "Running" | "Suspended",
    ) {
      const uid = a.data.uid;
      if (!uid) return yield* new Fault("MISSING_PROVIDER_IDENTITY");
      yield* external("Kubernetes.patchSandbox", () =>
        this.client.patch(this.config.namespace, a.id, [
          { op: "test", path: "/metadata/uid", value: uid },
          { op: "replace", path: "/spec/operatingMode", value: mode },
        ]),
      );
      yield* this.wait(a.id, uid, mode);
    }.bind(this),
  );
  park = Effect.fn("Kubernetes.park")(
    function* (this: KubernetesBackend, a: Allocation) {
      yield* this.io.quiesce(a);
      yield* this.mode(a, "Suspended");
    }.bind(this),
  );
  wake = Effect.fn("Kubernetes.wake")(
    function* (this: KubernetesBackend, a: Allocation, generation: number) {
      yield* this.mode(a, "Running");
      // The PVC survives suspension; the new Pod's controller directories do not.
      yield* this.io.initialize(a);
      return { ...a, generation };
    }.bind(this),
  );
  release = Effect.fn("Kubernetes.release")((a: Allocation) =>
    external("Kubernetes.deleteEphemeralSandbox", async () => {
      if (a.data.lifecycle !== "ephemeral" || !a.data.uid)
        throw new Fault("PERSISTENT_SANDBOX_DELETE_DENIED");
      try {
        await this.client.delete(this.config.namespace, a.id, a.data.uid);
      } catch (error) {
        if (!(error instanceof k8s.ApiException && error.code === 404))
          throw error;
      }
    }),
  );
  ephemeral(): EphemeralSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "ephemeral",
      initialize: this.initialize,
      create: this.createFor("ephemeral"),
      run: this.io.run,
      upload: this.io.upload,
      download: this.io.download,
      release: this.release,
    };
  }
  persistent(): PersistentSandboxBackend {
    return {
      capability: "sandbox",
      lifecycle: "persistent",
      initialize: this.initialize,
      create: this.createFor("persistent"),
      run: this.io.run,
      upload: this.io.upload,
      download: this.io.download,
      park: this.park,
      wake: this.wake,
    };
  }
}
