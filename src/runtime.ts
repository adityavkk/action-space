import { Context, Effect, Layer } from "effect";
import { Backends, type Registration } from "./backends/contracts.js";
import { QuickJSBackend } from "./backends/quickjs.js";
import { LocalNative } from "./backends/local.js";
import { Catalog, defineTool, type Tool } from "./catalog.js";
import {
  defaultBounds,
  type Auth,
  type Candidate,
  type ExecutionProfile,
  type Json,
} from "./domain.js";
import { external } from "./effects.js";
import { Journal } from "./journal.js";
import { RemoteMcp, emptyMcp } from "./mcp.js";
import { Observability } from "./observability.js";
import {
  ActionCatalog,
  McpBroker,
  ComputeRegistry,
  PlatformSettings,
  ResourceStore,
  WorkJournal,
  WorkManager,
  type Settings,
} from "./platform.js";
import { Policy } from "./policy.js";
import { DiskBlobs, Resources, type BlobStore } from "./resources.js";
import { FileTreeSchema, Tree } from "./schemas.js";
import { Schema } from "effect";

export const defaultSettings: Settings = {
  bounds: defaultBounds,
  profiles: [
    {
      capability: "code_execution",
      lifecycle: "invocation",
      id: "code-js-v1",
      continuity: "none",
    },
    {
      capability: "code_execution",
      lifecycle: "invocation",
      id: "code-mcp-js-v1",
      continuity: "none",
    },
    {
      capability: "sandbox",
      lifecycle: "ephemeral",
      id: "sandbox-python-ephemeral-v1",
      continuity: "none",
      recipe: "python3",
    },
    {
      capability: "sandbox",
      lifecycle: "persistent",
      id: "sandbox-linux-persistent-v1",
      continuity: "workspace",
      recipe: "python3",
    },
  ],
  region: "local",
  trust: "development",
  maxCost: null,
  tenantConcurrency: 4,
  globalConcurrency: 24,
  finalizationMs: 5000,
  autoRun: true,
};
export const localCandidate = <const P extends ExecutionProfile>(
  id: string,
  execution: P,
  profiles: string[],
) => ({
  id,
  ...execution,
  profiles,
  region: "local",
  trust: "development" as const,
  available: true,
  capacity: 8,
  maxMemoryBytes: 512 * 1024 * 1024,
  estimate: {
    cost: null,
    startupMs: null,
    transferMs: null,
    warmStartupMs: null,
  },
});
export function localBackends(directory: string): Registration[] {
  const native = new LocalNative(`${directory}/native`);
  return [
    {
      candidate: localCandidate(
        "quickjs",
        { capability: "code_execution", lifecycle: "invocation" },
        ["code-js-v1", "code-mcp-js-v1"],
      ),
      backend: new QuickJSBackend(),
    },
    {
      candidate: localCandidate(
        "local-ephemeral",
        { capability: "sandbox", lifecycle: "ephemeral" },
        ["sandbox-python-ephemeral-v1"],
      ),
      backend: native.ephemeral(),
    },
    {
      candidate: localCandidate(
        "local-persistent",
        { capability: "sandbox", lifecycle: "persistent" },
        ["sandbox-linux-persistent-v1"],
      ),
      backend: native.persistent(),
    },
  ];
}
export function builtInTools(
  resources: Resources,
  bounds = defaultBounds,
): Tool[] {
  return [
    defineTool({
      path: "data.sum",
      version: "v1",
      description: "Sum finite JSON numbers",
      effect: "read",
      grant: "data.read",
      approval: false,
      input: Schema.Struct({
        values: Schema.Array(Schema.Finite).check(Schema.isMaxLength(1000)),
      }),
      output: Schema.Struct({ sum: Schema.Finite }),
      invoke: Effect.fn("Data.sum")(function* (input) {
        return { sum: input.values.reduce((a, b) => a + b, 0) };
      }),
    }),
    defineTool({
      path: "resources.publish",
      version: "v1",
      description:
        "Publish an immutable portable file tree under the current resource owner",
      effect: "write",
      grant: "resources.write",
      approval: false,
      input: FileTreeSchema,
      output: Tree,
      invoke: Effect.fn("Resources.publish")(function* (files, { auth }) {
        return yield* external("Resources.publish", () =>
          resources.publish(auth.tenant, files, bounds),
        );
      }),
    }),
    defineTool({
      path: "resources.read",
      version: "v1",
      description:
        "Read an authorized immutable file tree without allocating native compute",
      effect: "read",
      grant: "resources.read",
      approval: false,
      input: Tree,
      output: FileTreeSchema,
      invoke: Effect.fn("Resources.read")(function* (tree, { auth }) {
        return yield* external("Resources.read", () =>
          resources.read(auth.tenant, tree),
        );
      }),
    }),
  ];
}
export function platformLayer(options: {
  directory: string;
  database?: string;
  principals: Auth[];
  settings?: Partial<Settings>;
  registrations?: Registration[];
  blobs?: BlobStore;
  tools?: Tool[];
  mcp?: RemoteMcp;
}) {
  const storage = Layer.effectContext(
    Effect.gen(function* () {
      const journal = yield* Effect.acquireRelease(
        external("Journal.open", () =>
          Journal.open(options.database ?? `${options.directory}/postgres`),
        ),
        (journal) =>
          external("Journal.close", () => journal.close()).pipe(Effect.orDie),
      );
      const resources = new Resources(
        journal,
        options.blobs ?? new DiskBlobs(`${options.directory}/objects`),
      );
      return Context.empty().pipe(
        Context.add(WorkJournal, journal),
        Context.add(ResourceStore, resources),
      );
    }),
  );
  const catalog = Layer.effect(
    ActionCatalog,
    Effect.gen(function* () {
      const resources = yield* ResourceStore;
      return yield* Catalog.build([
        ...builtInTools(resources, options.settings?.bounds ?? defaultBounds),
        ...(options.tools ?? []),
      ]);
    }),
  ).pipe(Layer.provide(storage));
  const dependencies = Layer.mergeAll(
    storage,
    catalog,
    Layer.succeed(McpBroker, options.mcp ?? new RemoteMcp(emptyMcp)),
    Layer.succeed(
      ComputeRegistry,
      new Backends(options.registrations ?? localBackends(options.directory)),
    ),
    Layer.succeed(PlatformSettings, {
      ...defaultSettings,
      ...options.settings,
    }),
    Policy.layer(options.principals),
    Observability.layer,
  );
  // Storage remains exposed for resource APIs and deterministic repository assertions.
  return WorkManager.layer.pipe(Layer.provideMerge(dependencies));
}
