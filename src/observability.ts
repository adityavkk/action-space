import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Metric,
  Option,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Otlp } from "effect/unstable/observability";
import type { Work } from "./domain.js";

export const WideEvent = Schema.Struct({
  event: Schema.Literal("action_space.work"),
  schemaVersion: Schema.Literal(2),
  transition: Schema.String,
  workId: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  action: Schema.String,
  capability: Schema.NullOr(Schema.Literals(["code_execution", "sandbox"])),
  lifecycle: Schema.NullOr(
    Schema.Literals(["invocation", "ephemeral", "persistent"]),
  ),
  catalog: Schema.String,
  phase: Schema.String,
  outcome: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  attempt: Schema.Number,
  elapsedMs: Schema.Number,
  queueMs: Schema.Number,
  childCount: Schema.Number,
  calls: Schema.Number,
  deadlineRemainingMs: Schema.Number,
  configuredCpuMs: Schema.Number,
  configuredHeapBytes: Schema.Number,
  placementScore: Schema.NullOr(Schema.Number),
  estimateUnknowns: Schema.Array(Schema.String),
  traceId: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  rejections: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      reasons: Schema.Array(Schema.String),
    }),
  ),
});
export interface WideEvent extends Schema.Schema.Type<typeof WideEvent> {}
export function workEvent(
  work: Work,
  transition: string,
  now: number,
): WideEvent {
  const chosen = work.placement?.chosen;
  return {
    event: "action_space.work",
    schemaVersion: 2,
    transition,
    workId: work.id,
    parentId: work.parent,
    action: work.call.action,
    capability: work.demand.capability,
    lifecycle: work.demand.lifecycle,
    catalog: work.catalog,
    phase: work.state.phase,
    outcome: work.state.phase === "settled" ? work.state.outcome.kind : null,
    provider: chosen?.candidate.id ?? null,
    attempt: work.lease?.generation ?? 0,
    elapsedMs: Math.max(0, now - work.created),
    queueMs: Math.max(0, (work.lease?.reservedAt ?? now) - work.created),
    childCount: work.state.children.length,
    calls: work.calls,
    deadlineRemainingMs: work.demand.deadline - now,
    configuredCpuMs: work.bounds.cpuMs,
    configuredHeapBytes: work.bounds.heapBytes,
    placementScore: chosen?.score ?? null,
    estimateUnknowns: chosen?.unknowns ?? [],
    rejections: work.placement?.rejected ?? [],
    traceId: work.trace?.traceId ?? null,
    failureCode:
      work.state.phase === "settled" && work.state.outcome.kind === "failed"
        ? work.state.outcome.code
        : null,
  };
}
const transitions = Metric.counter("action_space.work.transitions");
const duration = Metric.histogram("action_space.work.duration_ms", {
  boundaries: [10, 50, 100, 500, 1000, 5000, 10000, 60000],
});
export class Observability extends Context.Service<
  Observability,
  { emit: (work: Work, transition: string) => Effect.Effect<void> }
>()("action-space/Observability") {
  static readonly layer = Layer.effect(
    Observability,
    Effect.gen(function* () {
      return Observability.of({
        emit: Effect.fn("Observability.workEvent")(
          function* (work, transition) {
            const event = workEvent(
              work,
              transition,
              yield* Clock.currentTimeMillis,
            );
            yield* Effect.logInfo(event).pipe(
              Effect.annotateLogs({
                "event.name": event.event,
                "work.id": work.id,
              }),
            );
            // Low-cardinality metric dimensions only. Work/tenant IDs belong in events and traces.
            const attributes = {
              action: work.call.action,
              capability: work.demand.capability ?? "none",
              lifecycle: work.demand.lifecycle ?? "none",
              phase: work.state.phase,
            };
            yield* Metric.update(
              transitions.pipe(Metric.withAttributes(attributes)),
              1,
            );
            if (work.state.phase === "settled" && transition === "settled")
              yield* Metric.update(
                duration.pipe(Metric.withAttributes(attributes)),
                event.elapsedMs,
              );
          },
        ),
      });
    }),
  );
}
/** No telemetry leaves the process unless an operator supplies an endpoint. */
export const telemetryExport = Layer.unwrap(
  Effect.gen(function* () {
    const endpoint = yield* Config.option(
      Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"),
    );
    return Option.isSome(endpoint)
      ? Otlp.layerJson({
          baseUrl: endpoint.value,
          resource: { serviceName: "action-space", serviceVersion: "0.1.0" },
          loggerMergeWithExisting: true,
          maxBatchSize: 256,
          shutdownTimeout: "3 seconds",
        }).pipe(Layer.provide(FetchHttpClient.layer))
      : Layer.empty;
  }),
);
