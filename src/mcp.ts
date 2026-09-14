import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent } from "undici";
import ipaddr from "ipaddr.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ElicitRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Schema } from "effect";
import {
  Fault,
  Uncertain,
  type Auth,
  type Bounds,
  type Json,
  type ToolResult,
} from "./domain.js";
import { canonical, hash, json } from "./util.js";

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/));
export const ConnectionSelection = Schema.Array(Name)
  .check(Schema.isMaxLength(16))
  .pipe(Schema.mutable);
export const CredentialRef = Schema.Struct({
  id: Name,
  revision: Schema.NonEmptyString,
  identity: Schema.NonEmptyString,
});
const RegistryEntry = Schema.Struct({
  id: Name,
  revision: Schema.NonEmptyString,
  source: Schema.Literals(["company", "customer"]),
  endpoint: Schema.NonEmptyString,
  // Reviewed per endpoint. Empty means public HTTPS only. Never inferred from a URL supplied by source.
  privateCidrs: Schema.Array(Schema.String).pipe(Schema.mutable),
});
const Connection = Schema.Struct({
  id: Name,
  revision: Schema.NonEmptyString,
  registry: Name,
  credential: Schema.NullOr(CredentialRef),
});
export const McpConfiguration = Schema.Struct({
  registry: Schema.Array(RegistryEntry).pipe(Schema.mutable),
  connections: Schema.Array(Connection).pipe(Schema.mutable),
  credentials: Schema.Array(
    Schema.Struct({ ref: CredentialRef, tokenEnv: Schema.NonEmptyString }),
  ).pipe(Schema.mutable),
});
export type McpConfiguration = Schema.Schema.Type<typeof McpConfiguration>;
export const ToolDescriptor = Schema.Struct({
  path: Schema.NonEmptyString,
  description: Schema.String,
  inputSchema: Schema.MutableJson,
  outputSchema: Schema.optionalKey(Schema.MutableJson),
});
export type ToolDescriptor = Schema.Schema.Type<typeof ToolDescriptor>;
export const FrozenTools = Schema.Struct({
  protocol: Schema.Literal("remote_mcp_v1"),
  defaultsRevision: Schema.NullOr(Schema.Int),
  builtInCatalog: Schema.String,
  connections: Schema.Array(
    Schema.Struct({
      ...Connection.fields,
      entry: RegistryEntry,
      credentialFingerprint: Schema.NullOr(Schema.String),
      tools: Schema.Array(
        Schema.Struct({
          ...ToolDescriptor.fields,
          name: Schema.NonEmptyString,
        }),
      ).pipe(Schema.mutable),
    }),
  ).pipe(Schema.mutable),
});
export type FrozenTools = Schema.Schema.Type<typeof FrozenTools>;
export const emptyMcp: McpConfiguration = {
  registry: [],
  connections: [],
  credentials: [],
};
export const credentialKey = (ref: Schema.Schema.Type<typeof CredentialRef>) =>
  canonical(ref);

/** Exact endpoint + validated DNS at socket creation; no redirects, URL credentials or ambient proxy. */
export function endpointPolicy(
  entry: Schema.Schema.Type<typeof RegistryEntry>,
) {
  let url: URL;
  try {
    url = new URL(entry.endpoint);
  } catch {
    throw new Fault("MCP_ENDPOINT_DENIED");
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && entry.privateCidrs.length))
  )
    throw new Fault("MCP_ENDPOINT_DENIED");
  const ranges = entry.privateCidrs.map((cidr) => ipaddr.parseCIDR(cidr));
  const allowed = (address: string) => {
    const parsed = ipaddr.process(address);
    if (parsed.range() === "unicast" && url.protocol === "https:") return;
    if (
      ranges.some(
        ([network, bits]) =>
          network.kind() === parsed.kind() && parsed.match(network, bits),
      )
    )
      return;
    throw new Fault("MCP_ENDPOINT_DENIED");
  };
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = async () => {
    const found = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await lookup(hostname, { all: true });
    if (!found.length) throw new Fault("MCP_ENDPOINT_DENIED");
    for (const item of found) allowed(item.address);
    return found;
  };
  return { url, addresses, allowed };
}

export class RemoteMcp {
  constructor(
    readonly config: McpConfiguration,
    private readonly credentials = new Map<string, string>(),
  ) {
    for (const items of [config.registry, config.connections])
      if (new Set(items.map((x) => x.id)).size !== items.length)
        throw new Fault("MCP_DUPLICATE_ID");
    for (const entry of config.registry) endpointPolicy(entry);
  }
  authorize(auth: Auth, refs: string[]): void {
    if (new Set(refs).size !== refs.length)
      throw new Fault("MCP_DUPLICATE_SELECTION");
    for (const ref of refs)
      if (!auth.grants.includes(`mcp.use:${ref}`))
        throw new Fault("MCP_CONNECTION_DENIED");
  }
  private async session<T>(
    entry: Schema.Schema.Type<typeof RegistryEntry>,
    credential: Schema.Schema.Type<typeof CredentialRef> | null,
    deadline: number,
    signal: AbortSignal,
    bytes: number,
    run: (client: Client, interaction: () => boolean) => Promise<T>,
  ): Promise<T> {
    const policy = endpointPolicy(entry);
    await policy.addresses();
    const token = credential
      ? this.credentials.get(credentialKey(credential))
      : undefined;
    if (credential && !token) throw new Fault("MCP_CREDENTIAL_UNAVAILABLE");
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, options, callback) => {
          void policy.addresses().then(
            (items) => {
              const selected = items.filter(
                (x) => !options.family || x.family === options.family,
              );
              if (!selected.length) {
                callback(new Error("DNS unavailable"), "", 4);
                return;
              }
              if (options.all) callback(null, selected);
              else callback(null, selected[0]!.address, selected[0]!.family);
            },
            () => callback(new Error("Endpoint denied"), "", 4),
          );
        },
      },
    });
    const abort = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    ]);
    let interaction = false;
    const client = new Client(
      { name: "Action Space", version: "0.1.0" },
      { capabilities: { elicitation: {} } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      interaction = true;
      throw new McpError(
        ErrorCode.MethodNotFound,
        "MCP_INTERACTION_UNSUPPORTED: use the agent harness",
      );
    });
    const transport = new StreamableHTTPClientTransport(policy.url, {
      fetch: async (input, init) => {
        const target = new URL(
          input instanceof Request ? input.url : String(input),
        );
        if (target.href !== policy.url.href)
          throw new Fault("MCP_ENDPOINT_DENIED");
        await policy.addresses(); // IP literals bypass DNS lookup; check them too.
        const headers = new Headers(init?.headers);
        if (token) headers.set("authorization", `Bearer ${token}`);
        const options = {
          ...init,
          headers,
          signal: abort,
          redirect: "error" as const,
          dispatcher,
        };
        const response = await fetch(target, options);
        let count = 0;
        const body = response.body?.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              count += chunk.byteLength;
              if (count > bytes) throw new Fault("MCP_RESPONSE_LIMIT");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body ?? null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    });
    try {
      // MCP SDK's own Transport declaration omits explicit undefined on its class's optional sessionId.
      await client.connect(transport as Parameters<Client["connect"]>[0], {
        timeout: Math.max(1, deadline - Date.now()),
      });
      return await run(client, () => interaction);
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
      await dispatcher.destroy();
    }
  }
  async freeze(
    auth: Auth,
    refs: string[],
    defaultsRevision: number | null,
    builtInCatalog: string,
    bounds: Bounds,
  ): Promise<FrozenTools> {
    this.authorize(auth, refs);
    const frozen: FrozenTools = {
      protocol: "remote_mcp_v1",
      defaultsRevision,
      builtInCatalog,
      connections: [],
    };
    const deadline = Date.now() + Math.min(bounds.wallMs, 10_000);
    for (const ref of refs) {
      const connection = this.config.connections.find((x) => x.id === ref);
      const entry = this.config.registry.find(
        (x) => x.id === connection?.registry,
      );
      if (!connection || !entry) throw new Fault("MCP_CONNECTION_UNAVAILABLE");
      const tools = await this.session(
        entry,
        connection.credential,
        deadline,
        new AbortController().signal,
        1024 * 1024,
        async (client) => {
          const tools: FrozenTools["connections"][number]["tools"] = [];
          let cursor: string | undefined;
          const cursors = new Set<string>();
          do {
            const page = await client.listTools(cursor ? { cursor } : {}, {
              timeout: Math.max(1, deadline - Date.now()),
            });
            for (const tool of page.tools) {
              if (
                !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) ||
                ["constructor", "prototype", "__proto__", "then"].includes(
                  tool.name,
                )
              )
                throw new Fault("MCP_TOOL_NAME_UNSUPPORTED");
              const descriptor = {
                path: `mcp.${connection.id}.${tool.name}`,
                name: tool.name,
                description: tool.description ?? "",
                inputSchema: json(tool.inputSchema, bounds.resultBytes),
                ...(tool.outputSchema
                  ? {
                      outputSchema: json(tool.outputSchema, bounds.resultBytes),
                    }
                  : {}),
              };
              validator(descriptor.inputSchema);
              if (descriptor.outputSchema) validator(descriptor.outputSchema);
              tools.push(descriptor);
              if (tools.length > 200) throw new Fault("MCP_CATALOG_LIMIT");
            }
            cursor = page.nextCursor;
            if (cursor && cursors.has(cursor))
              throw new Fault("MCP_CATALOG_LIMIT");
            if (cursor) cursors.add(cursor);
          } while (cursor);
          if (new Set(tools.map((x) => x.name)).size !== tools.length)
            throw new Fault("MCP_DUPLICATE_TOOL");
          return tools;
        },
      );
      frozen.connections.push({
        ...connection,
        entry: { ...entry },
        tools,
        credentialFingerprint: connection.credential
          ? hash(this.credentials.get(credentialKey(connection.credential))!)
          : null,
      });
    }
    return Schema.decodeUnknownSync(FrozenTools)(json(frozen, 1024 * 1024));
  }
  async invoke(
    auth: Auth,
    snapshot: FrozenTools,
    path: string,
    input: Json,
    bounds: Bounds,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const connection = snapshot.connections.find((x) =>
      x.tools.some((t) => t.path === path),
    );
    const tool = connection?.tools.find((t) => t.path === path);
    if (!connection || !tool) throw new Fault("UNKNOWN_TOOL");
    this.authorize(auth, [connection.id]);
    const secret = connection.credential
      ? this.credentials.get(credentialKey(connection.credential))
      : undefined;
    if (
      connection.credential &&
      (!secret || hash(secret) !== connection.credentialFingerprint)
    )
      throw new Fault("MCP_CREDENTIAL_VERSION_CHANGED");
    if (!validator(tool.inputSchema)(input))
      return {
        ok: false,
        error: {
          code: "INVALID_TOOL_INPUT",
          message: "Input does not match the admitted tool schema",
        },
      };
    let dispatched = false;
    try {
      return await this.session(
        connection.entry,
        connection.credential,
        deadline,
        signal,
        bounds.resultBytes,
        async (client, interaction) => {
          dispatched = true;
          const result = await client.callTool(
            { name: tool.name, arguments: input as Record<string, Json> },
            undefined,
            { timeout: Math.max(1, deadline - Date.now()), signal },
          );
          if (interaction())
            throw new Uncertain(
              "MCP_INTERACTION_UNSUPPORTED: consult the harness; do not replay source",
            );
          if (result.isError)
            return {
              ok: false,
              error: {
                code: "MCP_TOOL_ERROR",
                message: "Remote MCP server returned a tool error",
                details: json(result.content, bounds.resultBytes),
              },
            };
          if (
            tool.outputSchema &&
            !validator(tool.outputSchema)(result.structuredContent)
          )
            throw new Uncertain(
              "MCP dispatched; output schema rejected the result",
            );
          // No schema means unknown, not a fabricated type. Preserve non-text MCP content.
          return {
            ok: true,
            data: json(
              result.structuredContent ?? { content: result.content },
              bounds.resultBytes,
            ),
          };
        },
      );
    } catch (error) {
      if (error instanceof Uncertain) throw error;
      if (dispatched)
        throw new Uncertain(
          "MCP response lost after dispatch; external effect outcome unknown",
        );
      if (error instanceof Fault) throw error;
      throw new Fault("MCP_CONNECTION_FAILED");
    }
  }
}
function validator(schema: Json) {
  // Bounded initial schema subset: untrusted recursive refs/regex must not stall the trusted broker.
  let nodes = 0;
  function check(value: Json, depth: number) {
    if (++nodes > 2000 || depth > 20) throw new Fault("MCP_SCHEMA_UNSUPPORTED");
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (
          [
            "$ref",
            "$dynamicRef",
            "$recursiveRef",
            "pattern",
            "patternProperties",
          ].includes(key)
        )
          throw new Fault("MCP_SCHEMA_UNSUPPORTED");
        check(child, depth + 1);
      }
    }
  }
  check(schema, 0);
  const modern =
    typeof schema === "object" &&
    schema !== null &&
    "$schema" in schema &&
    String(schema.$schema).includes("2020-12");
  try {
    return new (modern ? Ajv2020 : Ajv)({
      strict: false,
      allErrors: false,
      coerceTypes: false,
      validateFormats: false,
    }).compile(schema as object);
  } catch {
    throw new Fault("MCP_SCHEMA_UNSUPPORTED");
  }
}
export const toolsIdentity = (scope: FrozenTools) => hash(canonical(scope));
