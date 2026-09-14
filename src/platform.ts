import {
  Clock,
  Context as Services,
  Effect,
  Layer,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Tracer,
} from "effect";
import { Backends } from "./backends/contracts.js";
import type { PersistentSandboxBackend } from "./backends/contracts.js";
import { Catalog } from "./catalog.js";
import {
  RemoteMcp,
  ConnectionSelection,
  toolsIdentity,
  type FrozenTools,
} from "./mcp.js";
import {
  Fault,
  Interrupt,
  Uncertain,
  notStateful,
  type ActionName,
  type Allocation,
  type Auth,
  type BoundSandbox,
  type Bounds,
  type Context,
  type ExecutionError,
  type ExecutionProfile,
  type Invocation,
  type Json,
  type Outcome,
  type Output,
  type ProcessOutput,
  type Profile,
  type SandboxRef,
  type StateReceipt,
  type SubmitOptions,
  type Work,
  type WorkRef,
  type WorkState,
  type WorkspacePoint,
} from "./domain.js";
import { external, classify } from "./effects.js";
import { Journal, type Tx } from "./journal.js";
import { Observability } from "./observability.js";
import { Policy, requireGrant } from "./policy.js";
import { Resources } from "./resources.js";
import { fairOrder, selectPlacement } from "./scheduler.js";
import { Describe, Execute, InvocationSchema, Search } from "./schemas.js";
import { canonical, hash, id, json, relativePath } from "./util.js";

export class WorkJournal extends Services.Service<WorkJournal, Journal>()(
  "action-space/WorkJournal",
) {}
export class ResourceStore extends Services.Service<ResourceStore, Resources>()(
  "action-space/ResourceStore",
) {}
export class ActionCatalog extends Services.Service<ActionCatalog, Catalog>()(
  "action-space/ActionCatalog",
) {}
export class McpBroker extends Services.Service<McpBroker, RemoteMcp>()(
  "action-space/McpBroker",
) {}
export class ComputeRegistry extends Services.Service<
  ComputeRegistry,
  Backends
>()("action-space/ComputeRegistry") {}
export type Settings = {
  bounds: Bounds;
  profiles: Profile[];
  region: string;
  trust: "development" | "qualified";
  maxCost: number | null;
  tenantConcurrency: number;
  globalConcurrency: number;
  finalizationMs: number;
  autoRun: boolean;
};
export class PlatformSettings extends Services.Service<
  PlatformSettings,
  Settings
>()("action-space/PlatformSettings") {}
export interface WorkManagerApi {
  threadTools(
    auth: Auth,
  ): Effect.Effect<{ revision: number; connections: string[] }, ExecutionError>;
  configureTools(
    auth: Auth,
    connections: string[],
    expectedRevision: number,
  ): Effect.Effect<{ revision: number; connections: string[] }, ExecutionError>;
  submit<C extends Invocation>(
    auth: Auth,
    call: C,
    options: SubmitOptions<C["action"]>,
  ): Effect.Effect<WorkRef<Output<C["action"]>>, ExecutionError>;
  execute(
    auth: Auth,
    input: unknown,
    key: string,
  ): Effect.Effect<
    { work: WorkRef; catalog: string; status: WorkState },
    ExecutionError
  >;
  inspect(
    auth: Auth,
    id: string,
    waitMs?: number,
  ): Effect.Effect<Work, ExecutionError>;
  bind(
    auth: Auth,
    input: {
      key: string;
      expectedRevision: number | null;
      context: SandboxRef;
    },
  ): Effect.Effect<BoundSandbox, ExecutionError>;
  approve(
    auth: Auth,
    workId: string,
    digest: string,
  ): Effect.Effect<void, ExecutionError>;
  cancel(auth: Auth, workId: string): Effect.Effect<void, ExecutionError>;
  claim(): Effect.Effect<Work | null, ExecutionError>;
  dispatch(work: Work): Effect.Effect<void, ExecutionError>;
  pass(): Effect.Effect<void, ExecutionError>;
  recover(): Effect.Effect<void, ExecutionError>;
}
export class WorkManager extends Services.Service<
  WorkManager,
  WorkManagerApi
>()("action-space/WorkManager") {
  static readonly layer = Layer.effect(
    WorkManager,
    Effect.gen(function* () {
      const journal = yield* WorkJournal;
      const resources = yield* ResourceStore;
      const catalog = yield* ActionCatalog;
      const mcp = yield* McpBroker;
      const backends = yield* ComputeRegistry;
      const settings = yield* PlatformSettings;
      const policy = yield* Policy;
      const telemetry = yield* Observability;
      const scope = yield* Scope.Scope;
      const passLock = yield* Semaphore.make(1);
      const holder = id("coordinator");
      const controllers = new Map<string, AbortController>();
      const logs = new Map<string, string[]>();
      const transaction = <A>(name: string, fn: (tx: Tx) => Promise<A>) =>
        external(`Journal.${name}`, () => journal.transaction(fn));
      const checked = <A>(fn: () => A) =>
        Effect.try({ try: fn, catch: classify });
      const readThreadTools = async (tx: Tx, auth: Auth) =>
        (
          await tx.sql.query<{ revision: number; connections: string[] }>(
            "SELECT revision,connections FROM thread_tools WHERE tenant=$1 AND thread=$2",
            [auth.tenant, auth.thread],
          )
        ).rows[0] ?? { revision: 0, connections: [] };
      const threadTools = Effect.fn("Tools.threadDefaults")(function* (
        auth: Auth,
      ) {
        yield* policy.current(auth.tenant, auth.actor, auth.thread);
        return yield* transaction("threadTools", (tx) =>
          readThreadTools(tx, auth),
        );
      });
      const configureTools = Effect.fn("Tools.configure")(function* (
        auth: Auth,
        connections: string[],
        expectedRevision: number,
      ) {
        const current = yield* policy.current(
          auth.tenant,
          auth.actor,
          auth.thread,
        );
        const selected = yield* Schema.decodeUnknownEffect(ConnectionSelection)(
          connections,
        ).pipe(Effect.mapError(() => new Fault("INVALID_CONNECTIONS")));
        yield* checked(() => {
          if (!current.grants.includes("mcp.configure"))
            throw new Fault("DENIED");
          mcp.authorize(current, selected);
          for (const ref of selected)
            if (!mcp.config.connections.some((x) => x.id === ref))
              throw new Fault("MCP_CONNECTION_UNAVAILABLE");
        });
        return yield* transaction("configureTools", async (tx) => {
          const existing = await readThreadTools(tx, auth);
          if (existing.revision !== expectedRevision)
            throw new Fault("TOOLS_REVISION_CONFLICT");
          const revision = existing.revision + 1;
          await tx.sql.query(
            "INSERT INTO thread_tools(tenant,thread,revision,connections) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,thread) DO UPDATE SET revision=excluded.revision,connections=excluded.connections",
            [auth.tenant, auth.thread, revision, JSON.stringify(selected)],
          );
          return { revision, connections: selected };
        });
      });
      const getAuth = (work: Pick<Work, "tenant" | "actor" | "thread">) =>
        policy.current(work.tenant, work.actor, work.thread);
      const profile = (name: string, execution: ExecutionProfile) => {
        const found = settings.profiles.find(
          (x) =>
            x.id === name &&
            x.capability === execution.capability &&
            x.lifecycle === execution.lifecycle,
        );
        if (!found) throw new Fault("UNSUPPORTED_PROFILE");
        return found;
      };
      const connectorGrant = (call: Invocation) =>
        call.action === "connector.call"
          ? catalog.tool(call.input.path).grant
          : undefined;
      const access = (auth: Auth, work: Work | undefined): Work => {
        if (!work || work.tenant !== auth.tenant || work.thread !== auth.thread)
          throw new Fault("WORK_NOT_FOUND");
        return work;
      };
      const contextAccess = (
        auth: Auth,
        context: Context | undefined,
      ): Context => {
        if (
          !context ||
          context.tenant !== auth.tenant ||
          context.owner !== auth.thread
        )
          throw new Fault("CONTEXT_NOT_FOUND");
        return context;
      };
      const observe = Effect.fn("Work.inspect")(function* (
        auth: Auth,
        workId: string,
      ) {
        yield* policy.current(auth.tenant, auth.actor, auth.thread);
        return yield* transaction("inspect", async (tx) =>
          access(auth, await tx.work(workId)),
        );
      });
      const inspect = Effect.fn("Work.inspectWait")(function* (
        auth: Auth,
        workId: string,
        waitMs = 0,
      ) {
        const until =
          (yield* Clock.currentTimeMillis) +
          Math.min(Math.max(waitMs, 0), 10_000);
        return yield* observe(auth, workId).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            while: (work) =>
              Effect.map(
                Clock.currentTimeMillis,
                (now) =>
                  work.state.phase !== "settled" &&
                  work.state.phase !== "held" &&
                  work.state.phase !== "reconciling" &&
                  now < until,
              ),
          }),
        );
      });
      const admit = Effect.fn("Work.admit")(function* (
        auth: Auth,
        call: Invocation,
        key: string,
        finish: "record_result" | "seal_context",
      ) {
        const current = yield* policy.current(
          auth.tenant,
          auth.actor,
          auth.thread,
        );
        const parsed = yield* Schema.decodeUnknownEffect(InvocationSchema)(
          call,
          { onExcessProperty: "error" },
        ).pipe(Effect.mapError(() => new Fault("INVALID_INVOCATION")));
        const now = yield* Clock.currentTimeMillis;
        const span = yield* Effect.currentSpan.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        yield* checked(() => {
          if (
            !key ||
            key.length > 300 ||
            (finish === "seal_context" && parsed.action !== "sandbox.shell")
          )
            throw new Fault("INVALID_SUBMISSION");
        });
        const digest = hash(canonical({ call: parsed, finish }));
        // Retry lookup precedes remote discovery and all mutable defaults. Discovery admits no business effects.
        const duplicate = yield* transaction("lookupSubmission", async (tx) => {
          const existing = await tx.byKey(auth.tenant, key);
          if (existing) {
            access(auth, existing);
            if (existing.digest !== digest)
              throw new Fault("IDEMPOTENCY_CONFLICT");
          }
          return existing;
        });
        if (duplicate) return duplicate;
        yield* checked(() =>
          requireGrant(current, { call: parsed }, connectorGrant(parsed)),
        );
        let tools: FrozenTools | undefined;
        if (parsed.action === "code.execute") {
          const defaults = yield* threadTools(current);
          tools = yield* external("MCP.freeze", () =>
            mcp.freeze(
              current,
              parsed.input.connections ?? defaults.connections,
              parsed.input.connections === undefined ? defaults.revision : null,
              catalog.revision,
              settings.bounds,
            ),
          );
        }
        const work = yield* transaction("admit", async (tx) => {
          // Idempotency precedes binding resolution and current gate state, including child transport retries.
          const existing = await tx.byKey(auth.tenant, key);
          if (existing) {
            access(auth, existing);
            if (existing.digest !== digest)
              throw new Fault("IDEMPOTENCY_CONFLICT");
            return existing;
          }
          requireGrant(current, { call: parsed }, connectorGrant(parsed));
          if (parsed.action === "connector.call")
            catalog.check(parsed.input.path, "input", parsed.input.args);
          let context: Context | undefined;
          if (parsed.target) {
            const target =
              "context" in parsed.target
                ? parsed.target.context
                : parsed.target;
            context = contextAccess(auth, await tx.context(target.id));
            if ("revision" in parsed.target) {
              const binding = (
                await tx.sql.query<{ revision: number; context_id: string }>(
                  "SELECT revision,context_id FROM binding WHERE tenant=$1 AND thread=$2",
                  [auth.tenant, auth.thread],
                )
              ).rows[0];
              if (
                parsed.target.thread !== auth.thread ||
                !binding ||
                binding.revision !== parsed.target.revision ||
                binding.context_id !== target.id
              )
                throw new Fault("BINDING_CHANGED");
            }
          }
          const execution =
            parsed.action === "code.execute"
              ? ({
                  capability: "code_execution",
                  lifecycle: "invocation",
                } as const)
              : parsed.action === "sandbox.run"
                ? ({ capability: "sandbox", lifecycle: "ephemeral" } as const)
                : context
                  ? ({
                      capability: "sandbox",
                      lifecycle: "persistent",
                    } as const)
                  : { capability: null, lifecycle: null };
          const profileId =
            parsed.action === "sandbox.run"
              ? parsed.input.profile
              : (context?.spec.profile ??
                (execution.capability === "code_execution"
                  ? tools?.connections.length
                    ? "code-mcp-js-v1"
                    : "code-js-v1"
                  : "control"));
          if (execution.capability !== null) profile(profileId, execution);
          if (parsed.action === "context.ensure") {
            if (parsed.input.owner !== auth.thread)
              throw new Fault("OWNER_MISMATCH");
            profile(parsed.input.spec.profile, {
              capability: "sandbox",
              lifecycle: "persistent",
            });
          }
          const held =
            parsed.action === "connector.call" &&
            catalog.tool(parsed.input.path).approval;
          const work: Work = {
            id: id("work"),
            tenant: auth.tenant,
            actor: auth.actor,
            thread: auth.thread,
            key,
            digest,
            call: parsed,
            target: context ? { kind: "sandbox", id: context.id } : null,
            catalog: tools ? toolsIdentity(tools) : catalog.revision,
            ...(tools ? { tools } : {}),
            finish,
            bounds: { ...settings.bounds },
            demand: {
              ...execution,
              profile: profileId,
              region: settings.region,
              trust: settings.trust,
              deadline: now + settings.bounds.wallMs,
              maxCost: settings.maxCost,
              memoryBytes: settings.bounds.heapBytes,
              stickyBackend: context?.backend ?? null,
              warm: context?.phase.kind === "ready",
            },
            state: held
              ? {
                  phase: "held",
                  reason: "approval",
                  detail: "Exact Work digest requires an independent reviewer",
                  children: [],
                }
              : { phase: "queued", children: [] },
            parent: null,
            gate: true,
            calls: 0,
            inFlight: 0,
            created: now,
            trace: span
              ? {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  sampled: span.sampled,
                }
              : null,
            lease: null,
            placement: null,
            approved: null,
          };
          await tx.save(work);
          if (!held) await tx.enqueue(work.id);
          return work;
        });
        yield* telemetry.emit(work, "admitted");
        return work;
      });
      const submit: WorkManagerApi["submit"] = Effect.fn("Work.submit")(
        function* (auth, call, options) {
          const work = yield* admit(
            auth,
            call,
            options.key,
            options.finish ?? "record_result",
          );
          return { id: work.id };
        },
      );
      const setState = Effect.fn("Work.transition")(function* (
        original: Work,
        state: WorkState,
      ) {
        const result = yield* transaction("transition", async (tx) => {
          const work = await tx.work(original.id);
          if (!work) throw new Fault("WORK_NOT_FOUND");
          if (
            original.lease &&
            (work.lease?.generation !== original.lease.generation ||
              work.lease.holder !== original.lease.holder)
          )
            throw new Fault("STALE_ATTEMPT");
          if (work.state.phase === "settled") return work;
          work.state = { ...state, children: work.state.children };
          if (state.phase === "settled" || state.phase === "reconciling") {
            work.gate = false;
            await tx.sql.query(
              "UPDATE outbox SET state='done' WHERE work_id=$1",
              [work.id],
            );
            if (work.target) {
              const context = await tx.context(work.target.id);
              if (context?.busy === work.id) {
                if (state.phase === "reconciling")
                  context.phase = {
                    kind: "blocked",
                    allocation:
                      "allocation" in context.phase
                        ? context.phase.allocation
                        : null,
                    reason:
                      "uncertain execution; establish fencing before further mutation",
                  };
                else context.busy = null;
                await tx.saveContext(context);
              }
            }
          }
          await tx.save(work);
          return work;
        });
        yield* telemetry.emit(result, state.phase);
        return result;
      });
      const completed = (
        work: Work,
        output: unknown,
        state: StateReceipt = notStateful,
      ) =>
        setState(work, {
          phase: "settled",
          children: [],
          outcome: { kind: "completed", output, state },
        });
      const fail = Effect.fn("Work.recordFailure")(function* (
        work: Work,
        error: ExecutionError,
      ) {
        if (
          work.call.action === "code.execute" &&
          !(error instanceof Uncertain)
        ) {
          const unresolved = yield* transaction(
            "unobservedCalls",
            async (tx) =>
              (
                await tx.sql.query(
                  "SELECT 1 FROM event started WHERE started.work_id=$1 AND started.data->'tool'->>'phase'='started' AND NOT EXISTS (SELECT 1 FROM event observed WHERE observed.work_id=$1 AND observed.data->'tool'->>'phase'='observed' AND observed.data->'tool'->>'requestId'=started.data->'tool'->>'requestId') LIMIT 1",
                  [work.id],
                )
              ).rows.length > 0,
          );
          if (unresolved)
            error = new Uncertain(
              "Execution stopped with an unobserved tool outcome; do not replay source",
            );
        }
        if (error instanceof Uncertain)
          return yield* setState(work, {
            phase: "reconciling",
            children: [],
            known: ["attempt dispatched"],
            uncertain: [error.message],
            safeNext: "human_review",
          });
        if (error instanceof Interrupt)
          return yield* setState(work, {
            phase: "settled",
            children: [],
            outcome: {
              kind: "interrupted",
              reason: error.reason,
              partial: {
                result: null,
                logs: logs.get(work.id) ?? [],
                artifacts: [],
              },
            },
          });
        return yield* setState(work, {
          phase: "settled",
          children: [],
          outcome:
            error.code === "CANCELLED"
              ? { kind: "cancelled" }
              : {
                  kind: "failed",
                  code: error.code,
                  message: error.message,
                  evidence: null,
                },
        });
      });
      const claim = Effect.fn("Scheduler.claim")(function* () {
        const now = yield* Clock.currentTimeMillis;
        const all = yield* transaction("snapshot", (tx) => tx.works());
        const authorities = new Map<string, Auth>();
        const queued = all.filter(
          (w) =>
            w.state.phase === "queued" ||
            (w.state.phase === "held" && w.state.reason !== "approval"),
        );
        const snapshotIds = new Set(queued.map((work) => work.id));
        for (const work of queued) {
          const auth = yield* getAuth(work).pipe(
            Effect.catchTag("Fault", () => Effect.succeed(null)),
          );
          if (auth) authorities.set(work.id, auth);
        }
        const work = yield* transaction("claim", async (tx) => {
          const rows = await tx.works();
          const contexts = await tx.contexts();
          const cursor =
            (
              await tx.sql.query<{ last_tenant: string | null }>(
                "SELECT last_tenant FROM scheduler WHERE id=1 FOR UPDATE",
              )
            ).rows[0]?.last_tenant ?? null;
          const used: Record<string, number> = {};
          const activeTenants: Record<string, number> = {};
          const active = rows.filter(
            (w) =>
              w.state.phase === "running" ||
              w.state.phase === "finalizing" ||
              w.state.phase === "reconciling",
          );
          for (const activeWork of active) {
            if (activeWork.placement?.chosen) {
              const backend = activeWork.placement.chosen.candidate.id;
              used[backend] = (used[backend] ?? 0) + 1;
            }
            if (!activeWork.parent)
              activeTenants[activeWork.tenant] =
                (activeTenants[activeWork.tenant] ?? 0) + 1;
          }
          for (const allocation of (
            await tx.sql.query<{ backend: string; work_id: string }>(
              "SELECT backend,work_id FROM job_allocation WHERE released=false",
            )
          ).rows) {
            if (!active.some((w) => w.id === allocation.work_id))
              used[allocation.backend] = (used[allocation.backend] ?? 0) + 1;
          }
          for (const context of contexts)
            if (
              context.backend &&
              !context.busy &&
              context.phase.kind === "ready"
            )
              used[context.backend] = (used[context.backend] ?? 0) + 1;
          if (active.length >= settings.globalConcurrency) return null;
          const pending = (
            await tx.sql.query<{ work_id: string }>(
              "SELECT work_id FROM outbox WHERE state='pending' FOR UPDATE",
            )
          ).rows.map((x) => x.work_id);
          for (const work of fairOrder(
            // Newly admitted/approved Work waits for its own authority snapshot on the next pass.
            rows.filter((w) => pending.includes(w.id) && snapshotIds.has(w.id)),
            cursor,
          )) {
            const auth = authorities.get(work.id);
            if (!auth) {
              work.state = {
                phase: "settled",
                children: work.state.children,
                outcome: {
                  kind: "failed",
                  code: "DENIED",
                  message: "Authority revoked before dispatch",
                  evidence: null,
                },
              };
              work.gate = false;
              await tx.save(work);
              await tx.sql.query(
                "UPDATE outbox SET state='done' WHERE work_id=$1",
                [work.id],
              );
              continue;
            }
            try {
              requireGrant(auth, work, connectorGrant(work.call));
            } catch {
              work.state = {
                phase: "settled",
                children: work.state.children,
                outcome: {
                  kind: "failed",
                  code: "DENIED",
                  message: "Grant revoked before dispatch",
                  evidence: null,
                },
              };
              work.gate = false;
              await tx.save(work);
              await tx.sql.query(
                "UPDATE outbox SET state='done' WHERE work_id=$1",
                [work.id],
              );
              continue;
            }
            if (work.demand.deadline <= now) {
              work.state = {
                phase: "settled",
                children: work.state.children,
                outcome: {
                  kind: "failed",
                  code: "QUEUE_DEADLINE",
                  message: "No dispatch before deadline",
                  evidence: null,
                },
              };
              work.gate = false;
              await tx.save(work);
              await tx.sql.query(
                "UPDATE outbox SET state='done' WHERE work_id=$1",
                [work.id],
              );
              continue;
            }
            if (
              !work.parent &&
              (activeTenants[work.tenant] ?? 0) >= settings.tenantConcurrency
            )
              continue;
            const context = work.target
              ? contexts.find((c) => c.id === work.target?.id)
              : undefined;
            if (context && (context.busy || context.phase.kind === "blocked")) {
              work.state = {
                phase: "held",
                reason: "context",
                detail: "Exclusive mutation or unresolved state",
                children: work.state.children,
              };
              await tx.save(work);
              continue;
            }
            if (context) {
              work.demand.stickyBackend = context.backend;
              work.demand.warm = context.phase.kind === "ready";
            }
            if (work.demand.capability !== null) {
              const reservation =
                context?.backend && context.phase.kind === "ready"
                  ? {
                      ...used,
                      [context.backend]: Math.max(
                        0,
                        (used[context.backend] ?? 0) - 1,
                      ),
                    }
                  : used;
              work.placement = selectPlacement(
                work.demand,
                backends.entries.map((x) => x.candidate),
                reservation,
                now,
              );
              if (!work.placement.chosen) {
                work.state = {
                  phase: "held",
                  reason: "capacity",
                  detail: "No eligible placement; inspect rejection reasons",
                  children: work.state.children,
                };
                await tx.save(work);
                continue;
              }
            }
            if (
              work.call.action === "connector.call" &&
              catalog.tool(work.call.input.path).approval &&
              (!work.approved ||
                work.approved.digest !== work.digest ||
                work.approved.expiresAt <= now)
            ) {
              work.state = {
                phase: "held",
                reason: "approval",
                detail: "Approval missing or expired",
                children: work.state.children,
              };
              await tx.save(work);
              continue;
            }
            work.lease = {
              holder,
              generation: (work.lease?.generation ?? 0) + 1,
              reservedAt: now,
              expiresAt: Math.min(
                work.demand.deadline,
                now + work.bounds.wallMs,
              ),
            };
            work.state = {
              phase: "running",
              attempt: work.lease.generation,
              children: work.state.children,
            };
            if (context) {
              context.busy = work.id;
              context.lastActive = now;
              await tx.saveContext(context);
            }
            await tx.sql.query(
              "UPDATE outbox SET state='claimed',generation=$2 WHERE work_id=$1 AND state='pending'",
              [work.id, work.lease.generation],
            );
            await tx.sql.query(
              "UPDATE scheduler SET last_tenant=$1 WHERE id=1",
              [work.tenant],
            );
            await tx.save(work);
            return work;
          }
          return null;
        });
        if (work) yield* telemetry.emit(work, "dispatched");
        return work;
      });
      const saveContext = (context: Context) =>
        transaction("context", async (tx) => {
          const current = await tx.context(context.id);
          if (
            current &&
            (current.busy !== context.busy || current.epoch > context.epoch)
          )
            throw new Fault("STALE_CONTEXT");
          await tx.saveContext(context);
          return context;
        });
      const getContext = (work: Work) =>
        transaction("contextInspect", async (tx) => {
          const context = work.target && (await tx.context(work.target.id));
          if (!context || context.busy !== work.id)
            throw new Fault("CONTEXT_LEASE_LOST");
          return context;
        });
      const ensureAllocation = Effect.fn("Context.ensureAllocation")(function* (
        work: Work,
        context: Context,
        backend: PersistentSandboxBackend,
      ) {
        if (context.phase.kind === "blocked")
          return yield* new Fault("CONTEXT_BLOCKED");
        if (context.phase.kind === "ready") return context;
        const old = context.phase;
        const selected = work.placement?.chosen?.candidate.id;
        if (!selected) return yield* new Fault("NO_PLACEMENT");
        const selectedProfile = yield* checked(() =>
          profile(context.spec.profile, {
            capability: "sandbox",
            lifecycle: "persistent",
          }),
        );
        if (selectedProfile.lifecycle !== "persistent")
          return yield* new Fault("UNSUPPORTED_PROFILE");
        const generation = context.epoch + 1;
        let allocation: Allocation;
        if (old.kind === "parked")
          allocation = yield* backend.wake(old.allocation, generation);
        else {
          const seed = yield* external("Resource.seed", () =>
            resources.read(work.tenant, context.spec.seed),
          );
          allocation = yield* backend.create({
            operation: context.id,
            recipe: selectedProfile.recipe,
            generation,
            bounds: work.bounds,
          });
          // Persist allocation identity before materialization can fail.
          context.phase = { kind: "ready", allocation };
          context.backend = selected;
          context.epoch = generation;
          yield* saveContext(context);
          yield* backend.initialize(allocation).pipe(
            Effect.andThen(backend.upload(allocation, "/workspace", seed)),
            Effect.tapError(() => {
              context.phase = {
                kind: "blocked",
                allocation,
                reason:
                  "seed materialization incomplete; explicit repair required",
              };
              return saveContext(context);
            }),
          );
        }
        context.phase = { kind: "ready", allocation };
        context.backend = selected;
        context.epoch = generation;
        return yield* saveContext(context);
      });
      const seal = Effect.fn("Context.seal")(function* (
        work: Work,
        context: Context,
        backend: PersistentSandboxBackend,
      ) {
        if (context.phase.kind !== "ready")
          return yield* new Fault("CONTEXT_NOT_READY");
        const files = yield* backend.download(
          context.phase.allocation,
          "/workspace",
          work.bounds,
        );
        const tree = yield* external("Resource.publishSeal", () =>
          resources.publish(work.tenant, files, work.bounds),
        );
        const selectedProfile = yield* checked(() =>
          profile(context.spec.profile, {
            capability: "sandbox",
            lifecycle: "persistent",
          }),
        );
        if (selectedProfile.lifecycle !== "persistent")
          return yield* new Fault("UNSUPPORTED_PROFILE");
        const point: WorkspacePoint = {
          tree,
          cursor: { ...context.cursor },
          recipe: selectedProfile.recipe,
          roots: ["/workspace"],
          consistency: "filesystem",
        };
        context.lastSeal = point;
        yield* saveContext(context);
        return point;
      });
      const finalizeSandbox = Effect.fn("Sandbox.finalize")(function* (
        work: Work,
      ) {
        if (
          work.state.phase !== "finalizing" ||
          work.call.action !== "sandbox.run"
        )
          return;
        const backendId = work.placement?.chosen?.candidate.id;
        if (!backendId) return yield* new Fault("NO_PLACEMENT");
        const backend = backends.get(backendId, "sandbox", "ephemeral");
        const state = work.state;
        const files = yield* backend.download(
          state.allocation,
          "/out",
          work.bounds,
        );
        yield* checked(() => {
          if (work.call.action !== "sandbox.run") return;
          for (const path of work.call.input.outputs.required) {
            relativePath(path);
            if (!files[path])
              throw new Fault(
                "MISSING_OUTPUT",
                `Missing required output: ${path}`,
              );
          }
        });
        const tree = yield* external("Resource.publishSandboxOutput", () =>
          resources.publish(work.tenant, files, work.bounds),
        );
        yield* completed(work, {
          exitCode: 0,
          files: tree,
          log: state.execution,
        });
      });
      const broker = Effect.fn("Broker.call")(function* (
        parent: Work,
        path: string,
        input: Json,
        requestId: string,
        signal: AbortSignal,
      ) {
        const auth = yield* getAuth(parent);
        yield* checked(() => json(input, parent.bounds.argumentBytes));
        const now = yield* Clock.currentTimeMillis;
        const reservation = yield* transaction("reserveCall", async (tx) => {
          const live = await tx.work(parent.id);
          if (
            !live ||
            !live.gate ||
            live.lease?.generation !== parent.lease?.generation ||
            now >= live.demand.deadline
          )
            throw new Interrupt("child_pending");
          if (
            live.calls >= live.bounds.calls ||
            live.inFlight >= live.bounds.inFlight
          ) {
            live.gate = false;
            await tx.save(live);
            return { kind: "limit" as const };
          }
          live.calls++;
          live.inFlight++;
          await tx.save(live);
          await tx.sql.query(
            "INSERT INTO event(work_id,tenant,data) VALUES($1,$2,$3)",
            [
              parent.id,
              parent.tenant,
              JSON.stringify({ tool: { requestId, path, phase: "started" } }),
            ],
          );
          return { kind: "reserved" as const };
        });
        if (reservation.kind === "limit") return yield* new Interrupt("limit");
        const invoke = Effect.gen(function* () {
          if (parent.tools?.builtInCatalog !== catalog.revision)
            return yield* new Fault("CATALOG_UNAVAILABLE");
          if (path.startsWith("mcp."))
            return yield* external("MCP.invoke", () =>
              mcp.invoke(
                auth,
                parent.tools!,
                path,
                input,
                parent.bounds,
                parent.demand.deadline,
                signal,
              ),
            );
          if (path === "search") {
            const args = yield* Schema.decodeUnknownEffect(Search)(input, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(() => new Fault("INVALID_SEARCH")));
            return catalog.search(args.query, args.limit ?? 5, auth.grants);
          }
          if (path === "describe.tool") {
            const args = yield* Schema.decodeUnknownEffect(Describe)(input, {
              onExcessProperty: "error",
            }).pipe(Effect.mapError(() => new Fault("INVALID_DESCRIBE")));
            return yield* checked(() =>
              catalog.describe(args.path, auth.grants),
            );
          }
          const tool = yield* checked(() => {
            const tool = catalog.tool(path);
            if (!auth.grants.includes(tool.grant)) throw new Fault("DENIED");
            // Old approval-requiring built-ins are deliberately not imported into code mode.
            if (tool.approval) throw new Fault("LEGACY_TOOL_UNSUPPORTED");
            catalog.check(path, "input", input);
            return tool;
          });
          const result = yield* tool.invoke(input, { auth, workId: parent.id });
          yield* checked(() => {
            try {
              catalog.check(path, "output", result);
            } catch {
              throw new Uncertain("Tool dispatched; output contract failed");
            }
          });
          return { ok: true, data: result };
        });
        return yield* invoke.pipe(
          Effect.catch((error) =>
            error instanceof Fault && error.code !== "INTERNAL_ERROR"
              ? Effect.succeed({
                  ok: false,
                  error: { code: error.code, message: error.message },
                })
              : Effect.fail(
                  error instanceof Fault
                    ? new Uncertain("Tool outcome unknown")
                    : error,
                ),
          ),
          Effect.tap((result) =>
            transaction("toolObserved", async (tx) => {
              await tx.sql.query(
                "INSERT INTO event(work_id,tenant,data) VALUES($1,$2,$3)",
                [
                  parent.id,
                  parent.tenant,
                  JSON.stringify({
                    tool: {
                      requestId,
                      path,
                      phase: "observed",
                      ok:
                        typeof result === "object" &&
                        result !== null &&
                        "ok" in result
                          ? result.ok
                          : true,
                    },
                  }),
                ],
              );
            }),
          ),
          Effect.ensuring(
            transaction("releaseCall", async (tx) => {
              const work = await tx.work(parent.id);
              if (work) {
                work.inFlight = Math.max(0, work.inFlight - 1);
                await tx.save(work);
              }
            }).pipe(Effect.orDie),
          ),
        );
      });
      const run = Effect.fn("Work.run")(function* (
        work: Work,
        signal: AbortSignal,
      ) {
        const auth = yield* getAuth(work);
        yield* checked(() =>
          requireGrant(auth, work, connectorGrant(work.call)),
        );
        if ((work.tools?.builtInCatalog ?? work.catalog) !== catalog.revision)
          return yield* new Fault("CATALOG_UNAVAILABLE");
        const call = work.call;
        if (call.action === "connector.call") {
          const tool = yield* checked(() => {
            catalog.check(call.input.path, "input", call.input.args);
            return catalog.tool(call.input.path);
          });
          const output = yield* tool
            .invoke(call.input.args, { auth, workId: work.id })
            .pipe(
              Effect.catch((error) =>
                tool.effect === "write" &&
                (!(error instanceof Fault) ||
                  error.code === "INVALID_TOOL_OUTPUT" ||
                  error.code === "INTERNAL_ERROR")
                  ? Effect.fail(
                      new Uncertain(
                        "Connector outcome unknown; inspect original operation",
                      ),
                    )
                  : Effect.fail(error),
              ),
            );
          yield* checked(() => {
            try {
              catalog.check(call.input.path, "output", output);
            } catch {
              if (tool.effect === "write")
                throw new Uncertain(
                  "Write dispatched but output contract failed",
                );
              throw new Fault("INVALID_TOOL_OUTPUT");
            }
          });
          yield* completed(work, output);
          return;
        }
        if (call.action === "code.execute") {
          if (!work.tools)
            return yield* new Fault(
              "LEGACY_CODE_SCOPE",
              "Inspect legacy evidence; admitted source is not upgraded or replayed",
            );
          yield* checked(() =>
            mcp.authorize(
              auth,
              work.tools!.connections.map((x) => x.id),
            ),
          );
          const backendId = work.placement?.chosen?.candidate.id;
          if (!backendId) return yield* new Fault("NO_PLACEMENT");
          logs.set(work.id, []);
          let logBytes = 0;
          const runPromise = Effect.runPromiseWith(
            yield* Effect.context<never>(),
          );
          const calls = new Map<
            string,
            { digest: string; result: Promise<Json> }
          >();
          const output = yield* backends
            .get(backendId, "code_execution", "invocation")
            .execute({
              code: call.input.code,
              tools: [
                ...catalog.tools
                  .filter((x) => !x.approval && auth.grants.includes(x.grant))
                  .map((x) => ({
                    path: x.path,
                    description: x.description,
                    inputSchema: json(x.inputSchema, work.bounds.resultBytes),
                    outputSchema: json(x.outputSchema, work.bounds.resultBytes),
                  })),
                ...work.tools.connections.flatMap((x) => x.tools),
              ],
              bounds: work.bounds,
              deadline: work.demand.deadline,
              signal,
              bridge: (path, input, requestId) => {
                const digest = hash(canonical({ path, input }));
                const existing = calls.get(requestId);
                if (existing)
                  return existing.digest === digest
                    ? existing.result
                    : Promise.reject(
                        new Uncertain("Broker request identity conflict"),
                      );
                const result = runPromise(
                  broker(work, path, input, requestId, signal),
                );
                calls.set(requestId, { digest, result });
                return result;
              },
              log: (line) =>
                runPromise(
                  transaction("log", async (tx) => {
                    const current = await tx.work(work.id);
                    if (!current?.gate) return;
                    logBytes += Buffer.byteLength(line);
                    if (logBytes > work.bounds.logBytes)
                      throw new Interrupt("limit");
                    logs.get(work.id)?.push(line);
                    await tx.sql.query(
                      "INSERT INTO event(work_id,tenant,data) VALUES($1,$2,$3)",
                      [work.id, work.tenant, JSON.stringify({ log: line })],
                    );
                  }),
                ),
            });
          yield* completed(work, output);
          return;
        }
        if (call.action === "context.ensure") {
          yield* external("Resource.checkSeed", () =>
            resources.read(work.tenant, call.input.spec.seed),
          );
          const now = yield* Clock.currentTimeMillis;
          const context = yield* transaction("ensureContext", async (tx) => {
            const existing = (await tx.contexts()).find(
              (c) =>
                c.tenant === work.tenant &&
                c.owner === call.input.owner &&
                c.name === call.input.name,
            );
            if (existing) {
              if (canonical(existing.spec) !== canonical(call.input.spec))
                throw new Fault("CONTEXT_SPEC_CONFLICT");
              return existing;
            }
            const context: Context = {
              id: id("context"),
              tenant: work.tenant,
              owner: call.input.owner,
              name: call.input.name,
              spec: call.input.spec,
              cursor: { lineage: id("lineage"), step: 0 },
              epoch: 0,
              phase: { kind: "unallocated" },
              lastSeal: null,
              backend: null,
              busy: null,
              lastActive: now,
            };
            await tx.saveContext(context);
            return context;
          });
          yield* completed(work, { kind: "sandbox", id: context.id });
          return;
        }
        if (call.action === "sandbox.run") {
          const backendId = work.placement?.chosen?.candidate.id;
          if (!backendId) return yield* new Fault("NO_PLACEMENT");
          const backend = backends.get(backendId, "sandbox", "ephemeral");
          const selectedProfile = yield* checked(() =>
            profile(call.input.profile, {
              capability: "sandbox",
              lifecycle: "ephemeral",
            }),
          );
          if (selectedProfile.lifecycle !== "ephemeral")
            return yield* new Fault("UNSUPPORTED_PROFILE");
          const code = yield* external("Resource.sandboxCode", () =>
            resources.read(work.tenant, call.input.code),
          );
          const allocation = yield* backend.create({
            operation: work.id,
            recipe: selectedProfile.recipe,
            generation: work.lease?.generation ?? 1,
            bounds: work.bounds,
          });
          yield* transaction("sandboxAllocation", async (tx) => {
            await tx.sql.query(
              "INSERT INTO job_allocation(work_id,backend,allocation) VALUES($1,$2,$3)",
              [work.id, backendId, JSON.stringify(allocation)],
            );
          });
          yield* backend.initialize(allocation);
          yield* backend.upload(allocation, "/code", code);
          for (const [name, resource] of Object.entries(call.input.inputs)) {
            yield* checked(() => relativePath(name));
            yield* backend.upload(
              allocation,
              `/inputs/${name}`,
              yield* external("Resource.sandboxInput", () =>
                resources.read(work.tenant, resource),
              ),
            );
          }
          const execution = yield* backend.run(allocation, {
            argv: call.input.argv,
            cwd: "/scratch",
            bounds: work.bounds,
            deadline: work.demand.deadline,
            signal,
          });
          if (execution.exitCode !== 0) {
            yield* setState(work, {
              phase: "settled",
              children: [],
              outcome: {
                kind: "failed",
                code: "PROGRAM_EXIT",
                message: `Program exited ${execution.exitCode}`,
                evidence: json(execution, work.bounds.resultBytes),
              },
            });
            return;
          }
          yield* setState(work, {
            phase: "finalizing",
            children: [],
            stage: "output_publication",
            execution,
            allocation,
            expiresAt:
              (yield* Clock.currentTimeMillis) + settings.finalizationMs,
          });
          // The finalization pass alone owns publication/release. Never race two captures.
          return;
        }
        let context = yield* getContext(work);
        if (
          call.action === "context.sleep" &&
          context.phase.kind === "unallocated"
        ) {
          yield* completed(work, { kind: "already_unallocated" });
          return;
        }
        const backendId = work.placement?.chosen?.candidate.id;
        if (!backendId) return yield* new Fault("NO_PLACEMENT");
        const backend = backends.get(backendId, "sandbox", "persistent");
        context = yield* ensureAllocation(work, context, backend);
        if (context.phase.kind !== "ready")
          return yield* new Fault("CONTEXT_NOT_READY");
        const allocation = context.phase.allocation;
        const unsealed = (): StateReceipt => ({
          kind: "unsealed",
          cursor: context.cursor,
          lastSeal: context.lastSeal,
        });
        if (call.action === "sandbox.shell") {
          const execution = yield* backend.run(allocation, {
            argv: ["/bin/sh", "-lc", call.input.command],
            cwd: call.input.cwd,
            bounds: work.bounds,
            deadline: work.demand.deadline,
            signal,
          });
          context.cursor.step++;
          yield* saveContext(context);
          if (work.finish === "seal_context") {
            yield* seal(work, context, backend).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  setState(work, {
                    phase: "settled",
                    children: [],
                    outcome: {
                      kind: "seal_failed",
                      output: execution,
                      reason:
                        error instanceof Fault ? error.code : "capture failed",
                      state: unsealed(),
                    },
                  }),
                onSuccess: (point) =>
                  completed(work, execution, { kind: "sealed", point }),
              }),
            );
          } else yield* completed(work, execution, unsealed());
        } else if (call.action === "sandbox.read") {
          const path = yield* checked(() =>
            relativePath(call.input.path.replace(/^\/workspace\//, "")),
          );
          const tree = yield* backend.download(
            allocation,
            "/workspace",
            work.bounds,
          );
          const file = tree[path];
          if (!file) return yield* new Fault("FILE_NOT_FOUND");
          yield* completed(
            work,
            {
              text: Buffer.from(file.base64, "base64").toString(),
              cursor: context.cursor,
            },
            unsealed(),
          );
        } else if (call.action === "context.wake")
          yield* completed(
            work,
            {
              context: work.target,
              epoch: context.epoch,
              cursor: context.cursor,
              kind: context.epoch === 1 ? "created" : "remounted",
              discarded: ["processes", "sockets"],
              rootLayer: "not_promised",
            },
            unsealed(),
          );
        else {
          const point = yield* seal(work, context, backend);
          if (call.action === "context.sleep") {
            yield* backend.park(allocation);
            context.phase = { kind: "parked", allocation, point };
            yield* saveContext(context);
            yield* completed(
              work,
              { kind: "parked", point },
              { kind: "sealed", point },
            );
          } else yield* completed(work, point, { kind: "sealed", point });
        }
      });
      const dispatch = Effect.fn("Scheduler.dispatch")(function* (work: Work) {
        const accepted = yield* transaction("beginDispatch", async (tx) => {
          const current = await tx.work(work.id);
          if (
            !current ||
            current.state.phase !== "running" ||
            !current.gate ||
            current.lease?.holder !== holder ||
            current.lease.generation !== work.lease?.generation
          )
            return false;
          return (
            (
              await tx.sql.query(
                "UPDATE outbox SET state='dispatched' WHERE work_id=$1 AND generation=$2 AND state='claimed' RETURNING work_id",
                [work.id, current.lease.generation],
              )
            ).rows.length === 1
          );
        });
        if (!accepted) return;
        const controller = new AbortController();
        controllers.set(work.id, controller);
        const open = yield* transaction(
          "dispatchGate",
          async (tx) => (await tx.work(work.id))?.gate ?? false,
        );
        if (!open) {
          controllers.delete(work.id);
          yield* fail(work, new Fault("CANCELLED"));
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* run(work, controller.signal).pipe(
          Effect.timeoutOrElse({
            duration: Math.max(1, work.demand.deadline - now),
            orElse: () => {
              controller.abort();
              return Effect.fail(
                work.call.action === "code.execute"
                  ? new Interrupt("limit")
                  : new Uncertain(
                      "Execution deadline expired after dispatch; inspect original attempt",
                    ),
              );
            },
          }),
          Effect.catch((error) => Effect.asVoid(fail(work, error))),
          Effect.ensuring(
            Effect.sync(() => {
              controller.abort();
              controllers.delete(work.id);
              logs.delete(work.id);
            }),
          ),
          Effect.annotateSpans({
            "work.id": work.id,
            "work.parent_id": work.parent ?? "",
            "work.action": work.call.action,
            "work.catalog": work.catalog,
            "compute.provider":
              work.placement?.chosen?.candidate.id ?? "control",
          }),
          work.trace
            ? Effect.withParentSpan(Tracer.externalSpan(work.trace))
            : (effect) => effect,
        );
      });
      const recover = Effect.fn("Work.recover")(function* () {
        const changed = yield* transaction("recover", async (tx) => {
          const changed: Work[] = [];
          for (const work of await tx.works())
            if (work.state.phase === "running") {
              work.gate = false;
              work.state = {
                phase: "reconciling",
                children: work.state.children,
                known: ["previous attempt admitted"],
                uncertain: ["coordinator lost; no source or process replay"],
                safeNext: "human_review",
              };
              if (work.lease) {
                work.lease.generation++;
                work.lease.holder = holder;
              }
              await tx.save(work);
              await tx.sql.query(
                "UPDATE outbox SET state='done' WHERE work_id=$1",
                [work.id],
              );
              changed.push(work);
              if (work.target) {
                const context = await tx.context(work.target.id);
                if (context) {
                  context.epoch++;
                  context.phase = {
                    kind: "blocked",
                    allocation:
                      "allocation" in context.phase
                        ? context.phase.allocation
                        : null,
                    reason: "old executor not proven fenced",
                  };
                  await tx.saveContext(context);
                }
              }
            }
          return changed;
        });
        for (const work of changed)
          yield* telemetry.emit(work, "recovery_required");
      });
      const pass = Effect.fn("Scheduler.pass")(function* () {
        for (let n = 0; n < settings.globalConcurrency; n++) {
          const work = yield* claim();
          if (!work) break;
          yield* dispatch(work).pipe(Effect.forkIn(scope));
        }
        const now = yield* Clock.currentTimeMillis;
        const finalizing = yield* transaction("finalizers", async (tx) =>
          (await tx.works()).filter((w) => w.state.phase === "finalizing"),
        );
        for (const work of finalizing) {
          if (work.state.phase !== "finalizing") continue;
          if (work.state.expiresAt <= now) {
            const state = work.state;
            yield* setState(work, {
              phase: "settled",
              children: [],
              outcome: {
                kind: "failed",
                code: "OUTPUT_FAILED",
                message:
                  "Execution finished; publication lease expired. Do not rerun code.",
                evidence: json(state.execution, work.bounds.resultBytes),
              },
            });
          } else
            yield* finalizeSandbox(work).pipe(
              Effect.catch((error) =>
                telemetry.emit(work, `publication_retry.${error._tag}`),
              ),
            );
        }
        const releases = yield* transaction("releaseCandidates", async (tx) => {
          const settled = (await tx.works()).filter(
            (w) => w.state.phase === "settled",
          );
          return (
            await tx.sql.query<{
              work_id: string;
              backend: string;
              allocation: Allocation;
            }>(
              "SELECT work_id,backend,allocation FROM job_allocation WHERE released=false",
            )
          ).rows.filter((a) => settled.some((w) => w.id === a.work_id));
        });
        for (const release of releases)
          yield* backends
            .get(release.backend, "sandbox", "ephemeral")
            .release(release.allocation)
            .pipe(
              Effect.matchEffect({
                onSuccess: () =>
                  transaction("released", async (tx) => {
                    await tx.sql.query(
                      "UPDATE job_allocation SET released=true,release_error=null WHERE work_id=$1",
                      [release.work_id],
                    );
                  }),
                onFailure: (error) =>
                  transaction("releaseFailed", async (tx) => {
                    await tx.sql.query(
                      "UPDATE job_allocation SET release_error=$2 WHERE work_id=$1",
                      [release.work_id, error._tag],
                    );
                  }),
              }),
            );
        const contexts = yield* transaction("idleContexts", (tx) =>
          tx.contexts(),
        );
        for (const context of contexts)
          if (
            context.phase.kind === "ready" &&
            !context.busy &&
            now - context.lastActive >= context.spec.idleMs
          ) {
            const auth = yield* policy
              .current(
                context.tenant,
                (yield* transaction(
                  "owner",
                  async (tx) =>
                    (await tx.works()).find((w) => w.target?.id === context.id)
                      ?.actor,
                )) ?? "",
                context.owner,
              )
              .pipe(Effect.catchTag("Fault", () => Effect.succeed(null)));
            if (auth)
              yield* submit(
                auth,
                {
                  action: "context.sleep",
                  version: "v1",
                  target: { kind: "sandbox", id: context.id },
                  input: {},
                },
                {
                  key: `idle/${context.id}/${context.epoch}/${context.cursor.step}`,
                },
              );
          }
      }, passLock.withPermit);
      const bind = Effect.fn("Thread.bind")(function* (
        auth: Auth,
        input: {
          key: string;
          expectedRevision: number | null;
          context: SandboxRef;
        },
      ) {
        const current = yield* policy.current(
          auth.tenant,
          auth.actor,
          auth.thread,
        );
        if (!current.grants.includes("context.manage"))
          return yield* new Fault("DENIED");
        return yield* transaction("bind", async (tx) => {
          const digest = hash(canonical(input));
          const prior = (
            await tx.sql.query<{ digest: string; data: BoundSandbox }>(
              "SELECT digest,data FROM binding_request WHERE tenant=$1 AND request_key=$2",
              [auth.tenant, input.key],
            )
          ).rows[0];
          if (prior) {
            if (prior.digest !== digest)
              throw new Fault("IDEMPOTENCY_CONFLICT");
            return prior.data;
          }
          contextAccess(auth, await tx.context(input.context.id));
          const current = (
            await tx.sql.query<{ revision: number }>(
              "SELECT revision FROM binding WHERE tenant=$1 AND thread=$2",
              [auth.tenant, auth.thread],
            )
          ).rows[0];
          if ((current?.revision ?? null) !== input.expectedRevision)
            throw new Fault("BINDING_CHANGED");
          const binding: BoundSandbox = {
            thread: auth.thread,
            slot: "sandbox",
            revision: (current?.revision ?? 0) + 1,
            context: input.context,
          };
          await tx.sql.query(
            "INSERT INTO binding(tenant,thread,revision,context_id) VALUES($1,$2,$3,$4) ON CONFLICT(tenant,thread) DO UPDATE SET revision=excluded.revision,context_id=excluded.context_id",
            [auth.tenant, auth.thread, binding.revision, input.context.id],
          );
          await tx.sql.query(
            "INSERT INTO binding_request(tenant,request_key,digest,data) VALUES($1,$2,$3,$4)",
            [auth.tenant, input.key, digest, JSON.stringify(binding)],
          );
          return binding;
        });
      });
      const approve = Effect.fn("Approval.decide")(function* (
        auth: Auth,
        workId: string,
        digest: string,
      ) {
        const reviewer = yield* policy.current(
          auth.tenant,
          auth.actor,
          auth.thread,
        );
        if (!reviewer.reviewer) return yield* new Fault("DENIED");
        const now = yield* Clock.currentTimeMillis;
        yield* transaction("approve", async (tx) => {
          const work = access(auth, await tx.work(workId));
          if (
            work.actor === auth.actor ||
            work.digest !== digest ||
            work.state.phase !== "held" ||
            work.state.reason !== "approval"
          )
            throw new Fault("APPROVAL_MISMATCH");
          work.approved = {
            digest,
            actor: reviewer.actor,
            expiresAt: now + 60_000,
          };
          work.demand.deadline = now + work.bounds.wallMs;
          work.state = { phase: "queued", children: work.state.children };
          await tx.save(work);
          await tx.enqueue(work.id);
        });
      });
      const cancel = Effect.fn("Work.cancel")(function* (
        auth: Auth,
        workId: string,
      ) {
        const work = yield* observe(auth, workId);
        const undispatched = yield* transaction("closeGate", async (tx) => {
          const current = access(auth, await tx.work(workId));
          current.gate = false;
          await tx.save(current);
          return (
            (
              await tx.sql.query<{ state: string }>(
                "SELECT state FROM outbox WHERE work_id=$1",
                [workId],
              )
            ).rows[0]?.state === "claimed"
          );
        });
        const controller = controllers.get(workId);
        if (controller) controller.abort();
        else if (
          undispatched ||
          work.state.phase === "queued" ||
          work.state.phase === "held"
        )
          yield* fail(work, new Fault("CANCELLED"));
        // Accepted child effects and finalizers are not implicitly rolled back or discarded.
      });
      const execute = Effect.fn("Code.execute")(function* (
        auth: Auth,
        input: unknown,
        key: string,
      ) {
        const parsed = yield* Schema.decodeUnknownEffect(Execute)(input, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => new Fault("INVALID_EXECUTE")));
        const ref = yield* submit(
          auth,
          {
            action: "code.execute",
            version: "v1",
            target: null,
            input: parsed,
          },
          { key },
        );
        const work = yield* inspect(auth, ref.id, 1000);
        return { work: ref, catalog: work.catalog, status: work.state };
      });
      yield* recover();
      if (settings.autoRun)
        yield* pass().pipe(
          Effect.tapError((error) =>
            Effect.logError("scheduler.pass_failed", { code: error._tag }),
          ),
          Effect.ignore,
          Effect.repeat(Schedule.spaced("100 millis")),
          Effect.forkScoped,
        );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const controller of controllers.values()) controller.abort();
        }),
      );
      return WorkManager.of({
        threadTools,
        configureTools,
        submit,
        execute,
        inspect,
        bind,
        approve,
        cancel,
        claim,
        dispatch,
        pass,
        recover,
      });
    }),
  );
}
