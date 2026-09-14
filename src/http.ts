import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Effect, Schema, Tracer } from "effect";
import type { Auth } from "./domain.js";
import { Fault } from "./domain.js";
import { external } from "./effects.js";
import {
  ActionCatalog,
  ComputeRegistry,
  PlatformSettings,
  ResourceStore,
  WorkJournal,
  WorkManager,
} from "./platform.js";
import { FileTreeSchema, InvocationSchema, SandboxRef } from "./schemas.js";
import type { BridgeRegistry } from "./backends/cloudflare.js";
import { ConnectionSelection } from "./mcp.js";

const Submission = Schema.Struct({
  call: InvocationSchema,
  finish: Schema.optionalKey(
    Schema.Literals(["record_result", "seal_context"]),
  ),
});
const Binding = Schema.Struct({
  context: SandboxRef,
  expectedRevision: Schema.NullOr(Schema.Int),
});
const Approval = Schema.Struct({ digest: Schema.String });
const decode = <S extends Schema.Constraint & { DecodingServices: never }>(
  schema: S,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new Fault("INVALID_REQUEST")),
  );
function bearer(request: IncomingMessage): string {
  return request.headers.authorization?.replace(/^Bearer /, "") ?? "";
}
const readBody = (request: IncomingMessage, limit: number) =>
  external("HTTP.readBody", async () => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const part = Buffer.from(chunk);
      bytes += part.length;
      if (bytes > limit) throw new Fault("BODY_LIMIT");
      chunks.push(part);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
    } catch {
      throw new Fault("INVALID_JSON");
    }
  });
/** Thin authenticated transport: source bodies cannot supply tenant, authority, bounds or placement. */
export const serve = Effect.fn("HTTP.serve")(function* (options: {
  port: number;
  credentials: Map<string, Auth>;
  bridges: BridgeRegistry;
}) {
  const manager = yield* WorkManager;
  const resources = yield* ResourceStore;
  const journal = yield* WorkJournal;
  const catalog = yield* ActionCatalog;
  const registry = yield* ComputeRegistry;
  const settings = yield* PlatformSettings;
  const context = yield* Effect.context<never>();
  const handle = Effect.fn("HTTP.request")(function* (
    request: IncomingMessage,
  ) {
    const url = new URL(request.url ?? "/", "http://control.invalid");
    const path = url.pathname;
    if (path === "/health" && request.method === "GET") {
      const ready = yield* external("HTTP.databaseReady", () =>
        journal.transaction((tx) => tx.sql.query("SELECT 1")),
      ).pipe(Effect.match({ onSuccess: () => true, onFailure: () => false }));
      return {
        status: ready ? 200 : 503,
        body: { service: "Action Space", ready },
      };
    }
    if (path === "/internal/code-callback" && request.method === "POST") {
      const data = yield* options.bridges.handle(
        bearer(request),
        yield* readBody(request, settings.bounds.argumentBytes + 2048),
      );
      return { status: 200, body: data };
    }
    const token = Buffer.from(bearer(request));
    const auth = [...options.credentials].find(([secret]) => {
      const key = Buffer.from(secret);
      return token.length === key.length && timingSafeEqual(token, key);
    })?.[1];
    if (!auth) return yield* new Fault("UNAUTHORIZED");
    const key = request.headers["idempotency-key"];
    const submissionKey = () =>
      typeof key === "string" && key.length > 0
        ? Effect.succeed(key)
        : Effect.fail(new Fault("MISSING_IDEMPOTENCY_KEY"));
    if (path === "/v1/thread/tools" && request.method === "GET")
      return { status: 200, body: yield* manager.threadTools(auth) };
    if (path === "/v1/thread/tools" && request.method === "PUT") {
      const input = yield* decode(
        Schema.Struct({
          connections: ConnectionSelection,
          expectedRevision: Schema.Int,
        }),
        yield* readBody(request, 4096),
      );
      return {
        status: 200,
        body: yield* manager.configureTools(
          auth,
          input.connections,
          input.expectedRevision,
        ),
      };
    }
    if (request.method === "GET" && path === "/v1/capabilities")
      return {
        status: 200,
        body: {
          catalog: catalog.revision,
          providers: registry.entries.map((x) => x.candidate),
          profiles: settings.profiles,
          unsupported: [
            "services",
            "previews",
            "memory_checkpoint",
            "automatic_effect_replay",
          ],
        },
      };
    if (request.method === "GET" && path === "/v1/schemas")
      return {
        status: 200,
        body: {
          invocation: Schema.toJsonSchemaDocument(InvocationSchema),
          files: Schema.toJsonSchemaDocument(FileTreeSchema),
        },
      };
    if (request.method === "POST" && path === "/v1/execute")
      return {
        status: 202,
        body: yield* manager.execute(
          auth,
          yield* readBody(request, settings.bounds.sourceBytes + 1024),
          yield* submissionKey(),
        ),
      };
    if (request.method === "POST" && path === "/v1/work") {
      const body = yield* decode(
        Submission,
        yield* readBody(
          request,
          settings.bounds.argumentBytes + settings.bounds.sourceBytes,
        ),
      );
      return {
        status: 202,
        body: yield* manager.submit(auth, body.call, {
          key: yield* submissionKey(),
          ...(body.finish ? { finish: body.finish } : {}),
        }),
      };
    }
    if (request.method === "POST" && path === "/v1/binding") {
      const input = yield* decode(Binding, yield* readBody(request, 4096));
      return {
        status: 200,
        body: yield* manager.bind(auth, {
          ...input,
          key: yield* submissionKey(),
        }),
      };
    }
    if (path === "/v1/resources" && request.method === "POST") {
      if (!auth.grants.includes("resources.write"))
        return yield* new Fault("DENIED");
      const tree = yield* decode(
        FileTreeSchema,
        yield* readBody(request, settings.bounds.treeBytes * 2),
      );
      return {
        status: 201,
        body: yield* external("Resource.HTTP.publish", () =>
          resources.publish(auth.tenant, tree, settings.bounds),
        ),
      };
    }
    const resource = /^\/v1\/resources\/([a-f0-9]{64})$/.exec(path)?.[1];
    if (resource && request.method === "GET") {
      if (!auth.grants.includes("resources.read"))
        return yield* new Fault("DENIED");
      return {
        status: 200,
        body: yield* external("Resource.HTTP.read", () =>
          resources.read(auth.tenant, { kind: "file_tree", id: resource }),
        ),
      };
    }
    const match =
      /^\/v1\/work\/([a-zA-Z0-9_-]+)(?:\/(events|cancel|approve))?$/.exec(path);
    const id = match?.[1];
    const operation = match?.[2];
    if (id) {
      if (request.method === "GET" && !operation)
        return {
          status: 200,
          body: yield* manager.inspect(
            auth,
            id,
            Number(url.searchParams.get("waitMs") ?? 0) || 0,
          ),
        };
      if (request.method === "GET" && operation === "events") {
        yield* manager.inspect(auth, id);
        const after = Math.max(
          0,
          Number(url.searchParams.get("after") ?? 0) || 0,
        );
        return {
          status: 200,
          body: yield* external("Journal.events", () =>
            journal.transaction((tx) =>
              tx.sql.query(
                "SELECT sequence,data,created_at FROM event WHERE work_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100",
                [id, after],
              ),
            ),
          ),
        };
      }
      if (request.method === "POST" && operation === "cancel") {
        yield* manager.cancel(auth, id);
        return { status: 202, body: { work: { id } } };
      }
      if (request.method === "POST" && operation === "approve") {
        const input = yield* decode(Approval, yield* readBody(request, 2048));
        yield* manager.approve(auth, id, input.digest);
        return { status: 202, body: { work: { id } } };
      }
    }
    return yield* new Fault("NOT_FOUND");
  });
  const server = yield* Effect.acquireRelease(
    external(
      "HTTP.listen",
      () =>
        new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
          const server = createServer((request, response) => {
            const trace =
              /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(
                String(request.headers.traceparent ?? ""),
              );
            const parent =
              trace?.[1] &&
              trace[2] &&
              !/^0+$/.test(trace[1]) &&
              !/^0+$/.test(trace[2])
                ? Tracer.externalSpan({
                    traceId: trace[1],
                    spanId: trace[2],
                    sampled: true,
                  })
                : undefined;
            void Effect.runPromiseWith(context)(
              handle(request).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    status:
                      error instanceof Fault && error.code === "UNAUTHORIZED"
                        ? 401
                        : error instanceof Fault && error.code === "NOT_FOUND"
                          ? 404
                          : 409,
                    body: {
                      error: error instanceof Fault ? error.code : error._tag,
                      message:
                        "Request rejected; inspect existing Work before submitting another attempt",
                    },
                  }),
                ),
                Effect.withSpan("HTTP.exchange", {
                  kind: "server",
                  root: !parent,
                  ...(parent ? { parent } : {}),
                  attributes: {
                    "http.request.method": request.method ?? "UNKNOWN",
                  },
                }),
              ),
            ).then(
              (result) => {
                response.writeHead(result.status, {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                  "x-content-type-options": "nosniff",
                });
                response.end(JSON.stringify(result.body));
              },
              () => {
                response.writeHead(500);
                response.end('{"error":"INTERNAL_ERROR"}');
              },
            );
          });
          server.requestTimeout = 15_000;
          server.headersTimeout = 10_000;
          server.once("error", reject);
          server.listen(options.port, "0.0.0.0", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeIdleConnections();
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    return yield* new Fault("LISTEN_FAILED");
  yield* Effect.logInfo("http.ready", {
    port: address.port,
    auth: "bearer-required",
    mode: "development-unqualified",
  });
  return { port: address.port };
});
