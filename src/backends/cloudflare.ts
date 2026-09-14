import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  Fault,
  Interrupt,
  type Json,
  type CodeOutput,
  type ExecutionError,
} from "../domain.js";
import { external } from "../effects.js";
import { json } from "../util.js";
import { prepare } from "./prepare.js";
import type { CodeBackend, CodeRequest } from "./contracts.js";
export const CloudflareResult = Schema.Struct({
  result: Schema.MutableJson,
  logs: Schema.Array(Schema.String).pipe(Schema.mutable),
  artifacts: Schema.Array(
    Schema.Struct({ kind: Schema.Literal("file_tree"), id: Schema.String }),
  ).pipe(Schema.mutable),
});
const Callback = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("call"),
    requestId: Schema.String,
    path: Schema.String,
    input: Schema.MutableJson,
  }),
  Schema.Struct({ kind: Schema.Literal("log"), line: Schema.String }),
]);

/** Transient authenticated channel registry only. Work, gate and child evidence remain in Postgres. */
export class BridgeRegistry {
  private readonly channels = new Map<
    string,
    { request: CodeRequest; failure: ExecutionError | null; active: number }
  >();
  register(request: CodeRequest) {
    const token = randomBytes(32).toString("hex");
    const entry = {
      request,
      failure: null as ExecutionError | null,
      active: 0,
    };
    this.channels.set(token, entry);
    return {
      token,
      check: () => {
        if (entry.failure) throw entry.failure;
        if (entry.active) throw new Interrupt("child_pending");
      },
      close: () => {
        this.channels.delete(token);
      },
    };
  }
  handle = Effect.fn("Cloudflare.brokerCallback")(
    function* (this: BridgeRegistry, token: string, body: unknown) {
      const entry = this.channels.get(token);
      const channel = entry?.request;
      if (
        !entry ||
        !channel ||
        entry.failure ||
        channel.signal.aborted ||
        Date.now() >= channel.deadline
      )
        return yield* new Fault("CHANNEL_CLOSED");
      const payload = yield* Schema.decodeUnknownEffect(Callback)(body, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => new Fault("INVALID_BRIDGE")));
      if (payload.kind === "log") {
        yield* external("Cloudflare.log", () => channel.log(payload.line));
        return null;
      }
      entry.active++;
      return yield* external("Cloudflare.call", () =>
        channel.bridge(
          payload.path,
          json(payload.input, channel.bounds.argumentBytes),
          payload.requestId,
        ),
      ).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            entry.failure = error;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            entry.active--;
          }),
        ),
      );
    }.bind(this),
  );
}
export class CloudflareBackend implements CodeBackend {
  readonly capability = "code_execution";
  readonly lifecycle = "invocation";
  constructor(
    readonly config: {
      gatewayUrl: string;
      gatewayToken: string;
      brokerUrl: string;
    },
    readonly registry: BridgeRegistry,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  execute = Effect.fn("Cloudflare.execute")(
    function* (this: CloudflareBackend, request: CodeRequest) {
      if (request.tools?.some((tool) => tool.path.startsWith("mcp.")))
        return yield* new Fault(
          "UNSUPPORTED_CODE_PROFILE",
          "Remote MCP catalogs require the Executor/QuickJS profile",
        );
      const program = yield* Effect.try({
        try: () => prepare(request.code, request.bounds.sourceBytes),
        catch: () => new Fault("INVALID_SOURCE"),
      });
      const channel = this.registry.register(request);
      return yield* external("Cloudflare.gateway", async (signal) => {
        const deadline = AbortSignal.timeout(
          Math.max(1, request.deadline - Date.now()),
        );
        const response = await this.fetcher(this.config.gatewayUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            program,
            bounds: request.bounds,
            deadline: request.deadline,
            channel: channel.token,
            brokerUrl: this.config.brokerUrl,
          }),
          signal: AbortSignal.any([signal, request.signal, deadline]),
        });
        channel.check();
        if (!response.ok)
          throw new Interrupt(
            response.status === 409 ? "child_pending" : "isolate_lost",
          );
        const reader = response.body?.getReader();
        if (!reader) throw new Interrupt("isolate_lost");
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.length;
          if (
            bytes >
            request.bounds.resultBytes + request.bounds.logBytes + 1024
          ) {
            await reader.cancel();
            throw new Interrupt("limit");
          }
          chunks.push(part.value);
        }
        return Schema.decodeUnknownSync(CloudflareResult)(
          JSON.parse(Buffer.concat(chunks).toString()),
        );
      }).pipe(Effect.ensuring(Effect.sync(channel.close)));
    }.bind(this),
  );
}
