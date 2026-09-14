import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Schema } from "effect";
import { createServer } from "node:http";
import { serve } from "../src/http.js";
import { BridgeRegistry } from "../src/backends/cloudflare.js";
import { telemetryExport } from "../src/observability.js";
import { WorkSchema } from "../src/schemas.js";
import { fixture, principal, output } from "./fixture.js";

it.live(
  "exports real OTLP traces, wide logs and metrics across authenticated HTTP → queue → QuickJS → broker",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const received: Array<{ path: string; body: string }> = [];
        const collector = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<ReturnType<typeof createServer>>((resolve) => {
                const server = createServer(async (request, response) => {
                  const chunks: Buffer[] = [];
                  for await (const chunk of request)
                    chunks.push(Buffer.from(chunk));
                  received.push({
                    path: request.url ?? "",
                    body: Buffer.concat(chunks).toString(),
                  });
                  response.writeHead(200, {
                    "content-type": "application/json",
                  });
                  response.end("{}");
                });
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
          ),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => server.close(() => resolve())),
            ),
        );
        const address = collector.address();
        if (!address || typeof address === "string")
          throw new Error("collector not listening");
        const telemetry = telemetryExport.pipe(
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
              }),
            ),
          ),
        );
        let workId = "";
        const token = "only-a-test-token-never-export-this-string";
        const traceId = "1234567890abcdef1234567890abcdef";
        yield* fixture(
          Effect.gen(function* () {
            const api = yield* serve({
              port: 0,
              credentials: new Map([[token, principal]]),
              bridges: new BridgeRegistry(),
            });
            const url = `http://127.0.0.1:${api.port}`;
            assert.equal(
              (yield* Effect.promise(() => fetch(`${url}/v1/capabilities`)))
                .status,
              401,
            );
            const headers = {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": "http-otlp",
              traceparent: `00-${traceId}-1122334455667788-01`,
            };
            const body = JSON.stringify({
              code: 'console.log("private-log-canary"); const a = await tools.data.sum({values:[3,8]}); return {a,secret:"private-result-canary"};',
            });
            const first = yield* Effect.promise(async () => {
              const r = await fetch(`${url}/v1/execute`, {
                method: "POST",
                headers,
                body,
              });
              assert.equal(r.status, 202);
              return r.json();
            });
            workId = first.work.id;
            const work = yield* Effect.promise(async () =>
              Schema.decodeUnknownSync(WorkSchema)(
                await (
                  await fetch(`${url}/v1/work/${workId}?waitMs=10000`, {
                    headers,
                  })
                ).json(),
              ),
            );
            assert.deepEqual(output(work), {
              result: {
                a: { ok: true, data: { sum: 11 } },
                secret: "private-result-canary",
              },
              logs: ["[log] private-log-canary"],
              artifacts: [],
            });
            assert.equal(work.trace?.traceId, traceId);
            assert.equal(work.state.children.length, 0);
            const duplicate = yield* Effect.promise(async () =>
              (
                await fetch(`${url}/v1/execute`, {
                  method: "POST",
                  headers,
                  body,
                })
              ).json(),
            );
            assert.equal(duplicate.work.id, workId);
            const events = yield* Effect.promise(async () =>
              (
                await fetch(`${url}/v1/work/${workId}/events`, { headers })
              ).json(),
            );
            assert.isAbove(events.rows.length, 2);
            const malformed = yield* Effect.promise(() =>
              fetch(`${url}/v1/execute`, {
                method: "POST",
                headers: { ...headers, "idempotency-key": "forged" },
                body: JSON.stringify({ code: "return 1", tenant: "victim" }),
              }),
            );
            assert.equal(malformed.status, 409);
          }),
        ).pipe(Effect.provide(telemetry));
        // Scope finalization flushes exporters; no sleeps or dependence on timer intervals.
        const traces = received
          .filter((x) => x.path === "/v1/traces")
          .map((x) => x.body)
          .join("");
        const logs = received
          .filter((x) => x.path === "/v1/logs")
          .map((x) => x.body)
          .join("");
        const metrics = received
          .filter((x) => x.path === "/v1/metrics")
          .map((x) => x.body)
          .join("");
        assert.include(traces, "QuickJS.execute");
        assert.include(traces, "Broker.call");
        assert.include(traces, traceId);
        assert.include(logs, "action_space.work");
        assert.include(logs, workId);
        assert.include(logs, "placementScore");
        assert.include(logs, "capability");
        assert.include(logs, "lifecycle");
        assert.include(metrics, "action_space.work.transitions");
        assert.include(metrics, "code_execution");
        assert.include(metrics, "invocation");
        assert.notInclude(logs + metrics, "offering");
        assert.notInclude(metrics, workId);
        for (const secret of [
          token,
          "private-log-canary",
          "private-result-canary",
          "values:[3,8]",
        ])
          assert.notInclude(traces + logs + metrics, secret);
      }),
    ),
);
