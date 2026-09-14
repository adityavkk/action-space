import { Config, Effect, Option, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { KubeConfig } from "@kubernetes/client-node";
import { BridgeRegistry, CloudflareBackend } from "./backends/cloudflare.js";
import { E2BBackend } from "./backends/e2b.js";
import { KubernetesBackend, kubernetesClient } from "./backends/kubernetes.js";
import { QuickJSBackend } from "./backends/quickjs.js";
import type { Registration, NativeRequest } from "./backends/contracts.js";
import { Fault, type Auth } from "./domain.js";
import { external } from "./effects.js";
import { CandidateSchema, Bounds } from "./schemas.js";
import { defaultSettings, localBackends } from "./runtime.js";
import { McpConfiguration, RemoteMcp, credentialKey, emptyMcp } from "./mcp.js";

const NativeConfig = {
  candidates: Schema.Array(CandidateSchema),
  recipes: Schema.Record(Schema.String, Schema.NonEmptyString),
};
const ProviderConfig = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("quickjs"),
    candidate: CandidateSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("cloudflare"),
    candidate: CandidateSchema,
    gatewayUrl: Schema.String,
    brokerUrl: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("e2b"),
    ...NativeConfig,
    timeoutMs: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("kubernetes"),
    ...NativeConfig,
    namespace: Schema.String,
    runtimeClass: Schema.String,
    storageClass: Schema.String,
    storage: Schema.String,
    readyTimeoutMs: Schema.Int,
  }),
]);
const AuthSchema = Schema.Struct({
  tenant: Schema.NonEmptyString,
  actor: Schema.NonEmptyString,
  thread: Schema.NonEmptyString,
  grants: Schema.Array(Schema.String).pipe(Schema.mutable),
  reviewer: Schema.Boolean,
});
export const Configuration = Schema.Struct({
  local: Schema.Boolean,
  mcp: Schema.optionalKey(McpConfiguration),
  principals: Schema.Array(
    Schema.Struct({ tokenEnv: Schema.NonEmptyString, auth: AuthSchema }),
  ),
  providers: Schema.Array(ProviderConfig),
  bounds: Schema.optionalKey(Bounds),
  scheduler: Schema.Struct({
    region: Schema.NonEmptyString,
    trust: Schema.Literals(["development", "qualified"]),
    tenantConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
    globalConcurrency: Schema.Int.check(Schema.isGreaterThan(1)),
    maxCost: Schema.NullOr(Schema.Finite),
  }),
});
export interface Configuration
  extends Schema.Schema.Type<typeof Configuration> {}
export const loadConfiguration = Effect.fn("Configuration.load")(function* () {
  const path = yield* Config.string("ACTION_SPACE_CONFIG").pipe(
    Config.withDefault("config/local.json"),
  );
  const directory = yield* Config.string("ACTION_SPACE_DATA").pipe(
    Config.withDefault(".data"),
  );
  const database = yield* Config.option(Config.string("DATABASE_URL"));
  const port = yield* Config.int("PORT").pipe(Config.withDefault(3000));
  const contents = yield* external("Configuration.read", () =>
    readFile(path, "utf8"),
  );
  const config = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Configuration),
  )(contents, { onExcessProperty: "error" });
  const credentials = new Map<string, Auth>();
  for (const principal of config.principals) {
    const token = yield* Config.string(principal.tokenEnv);
    if (token.length < 32 || credentials.has(token))
      return yield* new Fault(
        "INVALID_API_TOKEN",
        "Use unique random API tokens of at least 32 characters",
      );
    credentials.set(token, principal.auth);
  }
  const mcpConfig = config.mcp ?? emptyMcp;
  const mcpCredentials = new Map<string, string>();
  for (const credential of mcpConfig.credentials) {
    const key = credentialKey(credential.ref);
    if (mcpCredentials.has(key))
      return yield* new Fault("MCP_DUPLICATE_CREDENTIAL");
    mcpCredentials.set(key, yield* Config.string(credential.tokenEnv));
  }
  const bridges = new BridgeRegistry();
  const registrations: Registration[] = config.local
    ? localBackends(directory)
    : [];
  for (const provider of config.providers) {
    if (provider.kind === "quickjs") {
      if (provider.candidate.capability !== "code_execution")
        return yield* new Fault("UNSUPPORTED_PROVIDER_CONTRACT");
      registrations.push({
        candidate: provider.candidate,
        backend: new QuickJSBackend(),
      });
      continue;
    }
    if (provider.kind === "cloudflare") {
      const gatewayToken = yield* Config.string("CLOUDFLARE_GATEWAY_TOKEN");
      if (provider.candidate.capability !== "code_execution")
        return yield* new Fault("UNSUPPORTED_PROVIDER_CONTRACT");
      registrations.push({
        candidate: provider.candidate,
        backend: new CloudflareBackend({ ...provider, gatewayToken }, bridges),
      });
      continue;
    }
    const native =
      provider.kind === "e2b"
        ? new E2BBackend({
            apiKey: yield* Config.string("E2B_API_KEY"),
            timeoutMs: provider.timeoutMs,
          })
        : new KubernetesBackend(
            provider,
            kubernetesClient(
              yield* Effect.sync(() => {
                const config = new KubeConfig();
                config.loadFromDefault();
                return config;
              }),
            ),
          );
    for (const candidate of provider.candidates) {
      if (candidate.capability !== "sandbox")
        return yield* new Fault("UNSUPPORTED_PROVIDER_CONTRACT");
      const backend =
        candidate.lifecycle === "ephemeral"
          ? native.ephemeral()
          : native.persistent();
      const create = Effect.fn("Recipe.resolve")(function* (
        request: NativeRequest,
      ) {
        const recipe = provider.recipes[request.recipe];
        if (!recipe) return yield* new Fault("UNSUPPORTED_RECIPE");
        return yield* backend.create({ ...request, recipe });
      });
      if (backend.lifecycle === "ephemeral")
        registrations.push({
          candidate: { ...candidate, lifecycle: "ephemeral" },
          backend: { ...backend, create },
        });
      else
        registrations.push({
          candidate: { ...candidate, lifecycle: "persistent" },
          backend: { ...backend, create },
        });
    }
  }
  return {
    directory,
    database: Option.getOrElse(database, () => `${directory}/postgres`),
    port,
    credentials,
    mcp: new RemoteMcp(mcpConfig, mcpCredentials),
    bridges,
    registrations,
    principals: config.principals.map((x) => x.auth),
    settings: {
      ...defaultSettings,
      ...config.scheduler,
      bounds: config.bounds ?? defaultSettings.bounds,
    },
  };
});
