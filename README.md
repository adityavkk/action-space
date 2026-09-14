# Action Space

A runnable Work scheduler and managed code-mode access to remote MCP tools, built with **Effect 4**, PostgreSQL journaling, the actual **Executor SDK/execution engine**, and independently pluggable compute providers. It does not manage conversations or choose models.

**This is an executable development foundation, not a production hostile-tenant platform.** QuickJS, local native execution, the scheduler, recovery, authenticated HTTP and OTLP run without cloud credentials. Cloud adapters contain real integration code; their live infrastructure remains unqualified. This README, executable schemas and [Executor integration note](providers/executor/INTEGRATION.md) define the implementation contract. The seven root design/research documents preserve earlier proposals, explicitly marked where child-Work approvals, services and other features differ from the implementation.

Two capabilities, with explicit lifecycle profiles:

| Capability                        | Lifecycle    | Contract                                                                           | Default profile               |
| --------------------------------- | ------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| Code execution (`code_execution`) | `invocation` | Bounded stateless JavaScript and brokered tools                                    | `code-js-v1`                  |
| Sandbox (`sandbox`)               | `ephemeral`  | Finite native work; retain published outputs, release compute                      | `sandbox-python-ephemeral-v1` |
| Sandbox (`sandbox`)               | `persistent` | Thread-bound Context; retain declared `/workspace`, not RAM or whole-machine state | `sandbox-linux-persistent-v1` |

These are correlated types and runtime-validated contracts, not isolation tiers. Control-only Work has `capability:null,lifecycle:null`, not a third capability. Placement explanations independently report capability and lifecycle mismatches.

**Pre-release compatibility:** the retired Compose/Job/Project wire format is not aliased or automatically migrated. Old action/grant/profile names, Context references and binding slots must not be resubmitted as new attempts. Startup rejects old journals with `LEGACY_JOURNAL` before schema migration or recovery. Preserve the old database, objects and native workspace; select a new `ACTION_SPACE_DATA=.data/capabilities-v1` (and a separate `DATABASE_URL` when configured). Historical evidence remains intact. The development launcher stores the API token under the selected data root. OTLP wide-event schema version 2 replaces `offering` with `capability` and `lifecycle`.

## Run locally with Docker Compose

On your own machine, install Docker Engine/Desktop with Compose v2.20+ (including `up --wait`) and run from this repository:

```sh
docker compose up --build --wait
docker compose exec -T action-space node dist/scripts/container.js demo
```

No Node installation or cloud account is needed on the host. The default API is **http://127.0.0.1:3000**; only this port is published, bound to loopback. Set `ACTION_SPACE_PORT=3001` in an optional `.env` copied from `.env.example`, or set it to `0` for a Docker-assigned port and inspect `docker compose port action-space 3000`. The default project is `action-space`; use `docker compose -p another-name ...` for fully separate named volumes and containers, consistently on every command.

| Service                        | Ownership                                                                                                                  | Persistent storage                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `init` (exits successfully)    | Generate independent API/PostgreSQL secrets once, with mode 0600; refuse malformed existing files                          | `credentials`                                           |
| `postgres`                     | PostgreSQL 17 Work, outbox, bindings, Context metadata and resource manifests                                              | `postgres`                                              |
| `migrate` (exits successfully) | Initialize the current schema transactionally after PostgreSQL is healthy; release its coordinator lock before API startup | None                                                    |
| `action-space`                 | Authenticated API, scheduler, standalone QuickJS-WASM and development native Sandbox                                       | `data`: resources and declared workspaces under `/data` |
| `otel` (optional profile)      | Bounded OTLP receiver/debug exporter, never an authoritative journal                                                       | None                                                    |

The image uses Node 24 LTS, a lockfile-based `npm ci` build with cached dependencies, Python 3, and a non-root UID 1000 runtime. The API has a read-only root filesystem, dropped capabilities, no-new-privileges, bounded tmpfs, CPU/memory/process limits and an init process for signal/reaping behavior. **No privileged container or Docker socket mount is used.** Credentials and host `.data`, `.env`, Git and artifacts are excluded from the build context. API readiness checks the database, not just a listening socket. PostgreSQL and OTLP have no host-published ports.

**Trusted development commands only:** the native adapter runs under the control-plane UID and can access its mounted data/credential files and network. Docker contains this local environment; it does not isolate native work from the coordinator or from other tenants. QuickJS is a separate guest engine with broker-enforced authority, not a claim of production hostile-tenant isolation. Persistent Sandbox retains the declared workspace, not RAM or whole-machine state.

Useful commands:

```sh
docker compose ps --all                            # init/migrate Exited (0) is normal
docker compose logs --tail=100 -f action-space postgres
curl --fail http://127.0.0.1:3000/health
# Explicit private token access; never paste its output into logs/issues:
export ACTION_SPACE_TOKEN="$(docker compose exec -T action-space node dist/scripts/container.js token)"
# Use the authenticated API examples below; unauthenticated protected routes return 401.
docker compose exec -T action-space node dist/scripts/container.js demo
docker compose restart action-space
docker compose up --no-deps --wait action-space     # wait for readiness after restart
docker compose down                               # keeps all three named volumes
docker compose up --wait                           # reuses credentials, journal and files
```

The demo's first run expects the sample thread to be unbound. It then uses stable `local-demo-v2/*` keys: repeat invocations retrieve the same execution/mutation Work, while new read-only Work checks the **current** retained file and verifies the mutation count is still one. It asserts broker sums 11 and 5 and exact artifact `forty-two`. It never silently rebinds an existing unrelated workspace. Run it in a separate project if your sample thread already has other work.

Before rebuilding/upgrading an existing stack, run `docker compose stop action-space`, then `docker compose up --build --wait`. The migrator deliberately cannot acquire a database already owned by a running coordinator. Initialization is restart-safe and does not reinterpret legacy Work. A failed migration rolls back rather than leaving a partial schema; inspect `docker compose logs migrate`. Preserve/back up **all three volumes together**. This is the initial local schema initializer, not an unattended production migration framework. The older host `.data` and earlier Compose-project volumes are neither imported nor removed; incompatible legacy journals/credentials need explicit migration or a separately named project.

**Destructive reset, only when you intend to lose this project's Work, artifacts, workspace and credentials:**

```sh
docker compose down --volumes
docker compose up --build --wait
```

Cloud adapters stay opt-in. Set `ACTION_SPACE_CONFIG_FILE` to a reviewed configuration and supply provider environment variables/read-only credential mounts through a private Compose override. Keep secrets out of Dockerfiles, build arguments, committed configs and `.env.example`; never mount the Docker socket. The default does not require Cloudflare, Kubernetes or E2B credentials. For optional local OTLP, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel:4318` in `.env`, then run `docker compose --profile observability up --build --wait` with the API stopped first; inspect `docker compose logs otel`. This reuses the existing collector, without adding dashboards.

Run `bash scripts/test-compose.sh` (or `npm run test:compose`) for opt-in live verification. It builds an isolated, uniquely named disposable project; checks real PostgreSQL wire use, API auth, QuickJS/tools, exact native output, restart/container-recreation/down-up persistence and dedupe; and deletes **only its own** test volumes on exit. Requires Bash, Docker Compose and curl. It respects your selected Docker daemon/context; select the intended local daemon first.

### Try actual Executor with two remote MCP servers

Use a fresh local project, without company credentials. These are real HTTP MCP fixture servers with distinct credentials, asymmetric data (17 and 83), and persistent write counters; they are not corporate registry verification.

```sh
export COMPOSE_PROJECT_NAME=action-space-mcp
export COMPOSE_PROFILES=mcp
export ACTION_SPACE_CONFIG_FILE=./config/mcp-local.json
docker compose up --build --wait
docker compose exec -T action-space node dist/scripts/container.js mcp-demo
docker compose exec -T action-space node dist/scripts/container.js demo
docker compose down                 # retains all five volumes, including fixture counters
docker compose up --wait
docker compose exec -T action-space node dist/scripts/container.js mcp-demo
```

`mcp-demo` checks discovery, description, async invocation, output 11, tenant/credential isolation, per-invocation replacement, unchanged thread defaults and a remote write count of one. Its write uses a stable submission key, so repetition retrieves the original Work. The `mcp-red` and `mcp-blue` services are opt-in, have no published ports, and use separately generated credential files. The fixture config's broad RFC1918 allowances are **only for local Docker networks**; company endpoints require narrowly reviewed ranges. Run `npm run test:compose:mcp` for disposable build/up, restart, recreation, down/up and cleanup verification.

## Run directly without Docker

Requirements: Linux, Node 24 LTS, npm, Python 3, `/bin/sh`, and OpenSSL. The pinned development Node dependency makes npm scripts use Node 24 even if the host default differs.

```sh
npm ci
npm run setup:executor
npm run check
npm test
npm run build
./scripts/dev.sh
```

The script generates a private `.data/api-token` once and starts the API on port 3000. It does not log the token. `config/local.json` binds that token to tenant `local`, actor `agent`, thread `demo`. All API paths except `/health` require a bearer token; the internal Cloudflare callback instead requires a short-lived random execution capability. There is no browser dashboard.

In another terminal on the same machine:

```sh
export ACTION_SPACE_TOKEN="$(cat .data/api-token)"
npm run demo
```

The same repeatable demo exercises discovery, concurrent code-execution calls, immutable native artifacts and retained workspace reads. Its first run expects a fresh data directory/unbound sample thread; subsequent runs retrieve the original Work and verify current file contents. For another existing workspace, use its known binding revision in the API.

In an Amp orb, use supervised service tooling instead of backgrounding the process:

```sh
amp orb service start action-space --command './scripts/dev.sh' --portal
```

Use the returned authenticated portal URL from outside the orb. The API bearer token remains required in addition to portal authentication. Keep `.data`, tokens, kubeconfig and provider keys out of Git and telemetry.

## Submit an intention, then inspect the same Work

The HTTP transport is a thin wrapper around the exported `WorkManager` Effect service. `Idempotency-Key` is trusted harness metadata, not part of source code.

```sh
curl http://127.0.0.1:3000/v1/execute \
  -H "Authorization: Bearer $ACTION_SPACE_TOKEN" \
  -H 'Idempotency-Key: ledger-comparison-v1' \
  -H 'Content-Type: application/json' \
  -d '{"code":"const found = await tools.search({query: \"sum\"}); const type = await tools.describe.tool({path: \"data.sum\"}); return await tools.data.sum({values:[7,-2]});"}'
```

The response is `{work:{id}, catalog, status}`. The result is in `status.outcome.output.result` when completed. Otherwise call `GET /v1/work/<id>?waitMs=10000`; this observes existing Work and never reruns the source. Retrying a submission with the same key and body returns the same Work, even after rebinding. A changed body under that key conflicts. Initial observation is capped at one second; the execution deadline is separate.

Inside code execution:

```js
const descriptors = await tools.search({ query: "sum", limit: 5 });
const details = await tools.describe.tool({ path: "data.sum" });
const results = await Promise.all([
  tools["data.sum"]({ values: [3, 8] }),
  tools.data.sum({ values: [7, -2] }),
]);
console.log("finished", results.length);
return results; // [{ok:true,data:{sum:11}}, {ok:true,data:{sum:5}}]
```

There are no imports, Node APIs, filesystem access, credentials, cross-run heaps or arbitrary outbound network authority. Search and description are metadata, not business dispatch. **A code invocation is one Work; nested tool calls are diagnostic events, not child Work or independent scheduled operations.** The broker checks current connection authority and runtime schemas. Known tool failures are `{ok:false,error:{code,message,details?}}`; uncertain effects stop continuation. Business approvals belong to MCP servers and the agent harness. MCP elicitation is explicitly unsupported and never accepted automatically.

### Configure tools outside guest source

The trusted harness uses `GET /v1/thread/tools` and `PUT /v1/thread/tools` with `{connections:["red"],expectedRevision:0}`. The authenticated principal determines tenant/thread; `mcp.configure` and `mcp.use:<connection-id>` grants are required. Registry entries, connection references and versioned credential identities are distinct objects in `config/mcp-local.json`. Real credentials come from explicitly configured secret environment references, not an assumed company service account. OAuth/SSO, token refresh and corporate registry synchronization are not implemented.

`POST /v1/execute` accepts `{code,connections?}`. Omission uses thread defaults; an explicit array **replaces** them, and `[]` selects no remote connections. Authorized built-in resource/math tools remain separately granted. The host resolves and freezes endpoint/registry revisions, selected tool schemas, credential identity/revision/fingerprint and defaults revision before queuing. The source cannot override this scope. Retry lookup precedes discovery: changes to defaults, registry entries or catalogs cannot retarget an existing Work. Replacing secret bytes under an old credential revision fails closed; rotate with a new reference. Remote behavior behind an unchanged endpoint is still the MCP server's responsibility, not an immutable server snapshot.

Remote names are `mcp.<connection-id>.<tool-name>`, callable through `tools[path](args)`. Structured content becomes `data`; otherwise `data.content` preserves MCP content blocks. Missing output schemas remain `unknown`. Reviewed Streamable HTTP endpoints only: HTTPS/public addresses by default, no URL secrets/query/fragment, no redirects, DNS validation at socket creation and explicit private CIDRs per endpoint. The initial bounded JSON Schema subset rejects refs/regex and limits depth/nodes; format annotations are not validation. See [the integration decision and upgrade instructions](providers/executor/INTEGRATION.md).

**Existing data:** this change adds `thread_tools` without deleting/reinterpreting journals. Old completed Work remains readable. Old queued code without a frozen tool scope fails `LEGACY_CODE_SCOPE`, rather than running under new semantics. Legacy connector/approval records stay inspectable for evidence; new code mode creates none. The older offering-format guard above remains unchanged.

Other routes:

| Route                             | Contract                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /v1/work`                   | `{call:{action,version:"v1",target,input},finish?}`; returns Work reference.                   |
| `GET /v1/work/:id`                | Work, typed state, children, demand, lease, frozen target and placement explanation.           |
| `GET /v1/work/:id/events?after=N` | Up to 100 private journal entries with monotonic sequence; reconnect from the last cursor.     |
| `POST /v1/work/:id/cancel`        | Close admission and request supported stop. No rollback guarantee for external effects.        |
| `POST /v1/work/:id/approve`       | Legacy explicit connector evidence only; not used by code execution.                           |
| `POST /v1/binding`                | `{context:{kind:"sandbox",id},expectedRevision}` with idempotency key; returns slot `sandbox`. |
| `POST /v1/resources`              | Immutable regular-file tree: `{"path":{"base64":"...","executable":false}}`.                   |
| `GET /v1/resources/:id`           | Tenant-authorized immutable tree. No authority is embedded in the tree.                        |
| `GET /v1/capabilities`            | Configured providers, profiles and explicit unsupported features.                              |
| `GET /v1/schemas`                 | Generated JSON Schema for Actions and file-tree resources.                                     |

`examples/journeys.ts` contains executable native requests. `execute({code})` submits `code.execute`. Native Actions are `sandbox.run` (ephemeral), `sandbox.shell` and `sandbox.read` (persistent binding), plus `context.ensure`, `context.wake`, `context.sleep`, and `context.seal`. `finish:"seal_context"` is only valid for `sandbox.shell`. A new Context seeded from a sealed tree is a portable file-tree fork, not a process or authority clone.

## The scheduler filters before optimizing

Admission freezes Action/version, inputs, target/binding revision, catalog, authority identity and host bounds. Work and outbox insertion share a transaction. The controller checks current grants, deadlines, global and tenant concurrency, Context exclusivity, capability/lifecycle/profile, locality, trust, declared provider availability, memory capacity and estimated per-Work cost ceiling. Only feasible candidates are ranked.

The initial inspectable score is estimated cost + 0.001 × estimated startup/transfer milliseconds + 1000 per unknown estimate. The policy function accepts alternative weights; deployments supply explicit provider estimates in configuration. **These numbers are policy weights, not vendor prices or measured latency.** Unknown cost cannot satisfy a hard cost ceiling. Unknown duration is reported, not fabricated. Execution time is unknown: deadline checks reject impossible startup plans and enforce actual execution deadlines, not a prediction of successful completion.

The durable tenant cursor gives round-robin selection, FIFO inside a tenant, and per-tenant Work concurrency. Nested code calls share the invocation's bounded call count/concurrency and do not enter the compute scheduler. Reservations and generation-fenced outbox claims prevent competing loops from dispatching the same attempt. The initial coordinator is a singleton, enforced by a PostgreSQL advisory lock; it is not an HA multi-controller scheduler. The implementation scans the small journal and is not yet designed for large queues.

Ready Contexts are warm candidates. Once a Context has a provider, affinity is a hard constraint, including after parking: a cheaper candidate never moves running work or discards retained state. Idle ready Contexts receive ordinary journaled sleep Work after `idleMs`. There is no cross-tenant warm pool. Availability and estimates are operator configuration, not automatic vendor health or billing feeds. Cost ceilings are per-Work estimates, not guaranteed invoice caps or tenant billing ledgers.

## Compute adapters have different promises

| Adapter                        | Code execution           | Sandbox: ephemeral | Sandbox: persistent | Verification and continuity                                                                                                                                                                                  |
| ------------------------------ | ------------------------ | ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **QuickJS-WASM**               | Real                     | —                  | —                   | Locally executed fresh WASM module/runtime/context in a disposable Node 24 wrapper. Allocator, stack, cumulative wrapper CPU, output and wall watchdog bounds. No cloud dependency.                          |
| **Cloudflare Dynamic Workers** | Real gateway integration | —                  | —                   | SDK-shaped gateway/client contract tests and Wrangler bundle dry-run, not deployed execution. Fresh `LOADER.load`, broker entrypoint binding and `globalOutbound:null`.                                      |
| **Kubernetes Agent Sandbox**   | —                        | Real adapter       | Real adapter        | Official client integration; ephemeral uses emptyDir, persistent parks the Sandbox and retains the generated workspace PVC. Local live-controller validation is separate from production/Kata qualification. |
| **E2B**                        | —                        | Real adapter       | Real adapter        | Official SDK integration with realistic doubles, not live sandboxes. Offline create; stdin command handles; disk-only pause; explicit reboot connect. No exactly-once create contract.                       |
| **Local native development**   | —                        | Real               | Real                | Real shell/Python, artifact capture and retained directory. Only the declared workspace survives park/wake; volatile directories are discarded. Not OS/network confinement.                                  |

Configure providers using `ACTION_SPACE_CONFIG=config/providers.example.json` after filling in real endpoints, namespace/runtime/storage, per-provider recipe mappings and credentials. The example is intentionally unavailable/unqualified with unknown pricing. Remove unused provider entries; listed providers require their credentials at startup. `ACTION_SPACE_DATA` selects the private data root; `PORT` selects the API port. Provider registration is isolated in `configuration.ts`; domain scheduling contains no vendor switch.

### QuickJS is an engine boundary, not production tenant isolation

For standalone code execution, use `ACTION_SPACE_CONFIG=config/quickjs.json ./scripts/dev.sh`. This registers QuickJS explicitly with configurable placement estimates/capacity and no native or cloud backends. The default `local:true` preset enables both QuickJS and local native development; explicit QuickJS entries use `local:false` to avoid registering the same provider twice. Host execution bounds are configurable through the optional `bounds` object (all fields in `src/schemas.ts` are required when overriding it).

The pin is `quickjs-emscripten@0.32.0`, default `RELEASE_SYNC`, patched vendored Bellard QuickJS 2025-09-13. npm reports [this wrapper revision](https://github.com/justjake/quickjs-emscripten/commit/df4efb9ef2cb25c417ecb57986da462d11b244ed). The installed WASM SHA-256 is `105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232`, matching the research probe. This is **a reproducible identification of a feasibility pin, not a security approval**. The source provenance and newer upstream engine gaps are recorded in `COMPOSE_STACK_RESEARCH.md`.

Node only hosts the wrapper; agent source never executes in Node or `node:vm`. Each process has a fresh Executor instance/private in-memory catalog, no authoritative Executor run store, and a fresh QuickJS runtime. `providers/executor` pins SDK/execution/runtime 1.6.8 with its separate Effect beta.59 tree. The small vendored runtime patch retains wall/log/CPU limits; it does not copy the platform's old proxy and call it Executor. CPU metering starts after catalog setup and includes wrapper/tool overhead; wall and wrapper heap bounds cover setup too. A process kill provides development cleanup, not an OS sandbox. Qualify current engine patches/builds and a Kata/gVisor/comparable outer boundary, cgroup quotas, network policy and control-plane separation before admitting hostile tenants.

### Cloudflare requires a deployed Worker binding, not a generic REST sandbox API

`providers/cloudflare/worker.js` is a trusted gateway with a `LOADER` binding. `CloudflareBackend` sends it an authenticated execution envelope; the gateway binds a scoped broker capability into a fresh dynamic Worker. The child never receives the gateway token or upstream credentials. Its HTTP callback must reach `/internal/code-callback` on the same coordinator. Callback capabilities are revoked on completion, interruption or deadline. They are intentionally transient; reconnecting after control-plane loss inspects durable Work instead of recreating the JS continuation.

**Executor/MCP support is currently QuickJS-only.** Remote selections require profile `code-mcp-js-v1`, registered by QuickJS. Cloudflare retains `code-js-v1` and its existing built-in tool gateway; it does not run the upstream Executor stack. Do not advertise the MCP profile on Cloudflare. Its adapter also rejects remote tool descriptors explicitly, rather than silently presenting an incomplete catalog. Porting the actual upstream Worker runtime needs separate packaging/deployed-binding verification.

Set `CLOUDFLARE_GATEWAY_TOKEN` in the control component and matching `GATEWAY_TOKEN` in the gateway. Set the gateway `BROKER_URL` to the exact HTTPS callback URL. Cloudflare account access, Dynamic Workers entitlement and deployment approval are required. Do not run a deploy command without that approval. A locally checked bundle is not hosted isolation verification, and standalone workerd is not advertised as hosted Cloudflare hardening.

The managed runtime supplies platform-fixed memory limits, not QuickJS's exact per-invocation allocator limit. Broker counts, serialized sizes and logical deadlines are independently enforced. Deadline revocation is **not proof of immediate isolate termination**; native Workers web globals exist but outbound authority is denied. Qualify CPU/subrequest limits and post-disconnect compute tails before making strict resource/cost claims.

### Kubernetes retains its Sandbox and PVC; Claim deletion is not a sleep mechanism

The adapter targets `agents.x-k8s.io/v1beta1` and uses official `@kubernetes/client-node@2.0.0`. Supply kubeconfig (or in-cluster identity), an installed Agent Sandbox controller, a qualified RuntimeClass, a retained StorageClass and namespace-scoped RBAC for Sandboxes plus Pod list/exec. Apply the separately reviewed namespace egress policy before enabling an offline profile. Deployment credentials and Kata qualification must be supplied independently.

Creation uses a stable operation-derived name and annotation. A lost response is reconciled with GET; ownership/UID mismatch stops execution. Persistent volume mounts rely on the controller's generated PVC; there is no duplicate manual volume definition. `Suspended` must be observed at the current generation with `PodTerminated`, not merely desired state. Waking remounts under a new epoch. Only ephemeral Sandbox deletion is exposed, with a UID precondition. Persistent Sandboxes never delete their Sandbox/PVC during idle handling. SandboxClaim/expiry ownership is deliberately not used.

Build/review `providers/native/Dockerfile` and map recipe `python3` to its immutable image digest. The trusted guest controller runs as root and runs workload processes as dedicated UID 2000, with cleared groups, rlimits and bounded pipes. It quiesces workload-owned processes before capture. This requires a reviewed image without workload sudo/capabilities and a qualified outer sandbox. Pod exec/socket loss cannot prove remote stop: Work remains reconciling and its Context blocked.

The opt-in live harness runs the **HTTP → Work → scheduler → Kubernetes adapter** path, not just `kubectl` commands. It requires an already approved disposable cluster with the controller installed. Review `providers/kubernetes/live-test-scope.example.yaml` for namespace ownership, quota, network policy and restricted control-plane RBAC; installation and applying those resources are separate approval steps. Use a separate inspection/cleanup identity for the harness. It refuses an unlabelled namespace, checks API discovery and RuntimeClass, and deletes only its operation/UID-owned allocations in `finally`.

```sh
npm run build
export KUBECONFIG=/private/test-control-kubeconfig
export ACTION_SPACE_LIVE_ADMIN_KUBECONFIG=/private/test-inspector-kubeconfig
export ACTION_SPACE_LIVE_NAMESPACE=as-live-example
export ACTION_SPACE_LIVE_TEST_ID=example
export ACTION_SPACE_LIVE_IMAGE='registry.example/reviewed-runtime@sha256:<digest>'
export ACTION_SPACE_LIVE_RUNTIME_CLASS=as-test-runc
export ACTION_SPACE_LIVE_STORAGE_CLASS=local-path
npm run test:kubernetes:live
```

The completed local test used **k3s v1.36.4+k3s1, Agent Sandbox v1.0.2, API v1beta1 and runc**. It published `43` from declared inputs, observed `Suspended/PodTerminated` with no Pod and the same Bound PVC, woke a new Pod, read the exact 729-byte workspace file, discarded a `/tmp` marker, and returned the original attempt for duplicate and restarted-coordinator submissions. The real wake path exposed a retained-directory permission bug; controller initialization now restores root ownership before setting permissions, then hands the workspace back to the workload UID without adding capabilities. Provider regressions cover that ordering. No Sandbox services are claimed: successful native commands prove guest-worker readiness separately from Pod readiness.

Raw operational reports, kubeconfigs and journals are deliberately excluded from the repository; the opt-in harness can reproduce this test against separately approved disposable infrastructure. Test allocation cleanup was observed, not merely requested. This is controller/API and disk-continuity validation on an orb-local standard runtime, **not Kata or hostile-tenant isolation qualification**. No Cloudflare or E2B deployment was involved.

### E2B continuity is provider-dependent disk recovery

Set `E2B_API_KEY` only in the trusted control plane. Map recipe `python3` to a reviewed E2B template with Python 3, dedicated UID 2000 and no workload privilege escalation. The adapter uses `e2b@2.49.1`: `Sandbox.create`, `Sandbox.getInfo`, `Sandbox.connect`, `commands.run({background:true,stdin:true,user:"root"})`, command stdin/close/wait, `pause({keepMemory:false})`, `connect({onResume:"reboot"})`, and `Sandbox.kill`.

Create has no idempotency key. An ambiguous response becomes `reconciling`; inspect metadata `actionSpaceOperation` before any manual repair. Existing allocation IDs are durable. E2B may retain more filesystem state than Action Space promises; only declared workspace/recipe continuity is contractual. Provider expiration, resume support, storage durability and template security still need live qualification. Paused instances are not immutable seals.

## Failure evidence survives the runtime

- Source failure, cancellation or timeout preserves the invocation and diagnostic call observations. Unobserved external outcomes become `reconciling`; they do not become generic retryable failures. No arbitrary JS continuation or per-tool exactly-once promise is made.
- Business approval/elicitation belongs upstream. An unsupported MCP interaction stops source; Action Space creates no child approval Work and never enables Executor's `autoApprove`/`accept-all` paths.
- Unknown write outcomes remain `reconciling`, with the conflict held. Known failures are distinct. Custom connectors must classify errors honestly; `Fault` means a known outcome, `Uncertain` means do not replay.
- Ephemeral Sandbox execution success enters `finalizing`; object publication retries under a separate deadline. Expiry preserves execution evidence and returns `OUTPUT_FAILED`, explicitly without rerunning source. Allocation identities and failed release attempts remain journaled until release succeeds.
- `seal_failed` preserves completed shell output. Submit `context.seal` to retry capture, never the original shell command. Seals are bounded immutable regular-file trees, not RAM/root-layer checkpoints.
- A replacement coordinator closes orphaned running gates, advances fencing generations, preserves children and blocks uncertain Contexts. It never automatically redispatches ambiguous native processes or business effects. Queued work and output finalizers can continue from their recorded stages.

Resources reject traversal, symlinks, hardlinks, non-regular files, conflicting paths and declared size/count violations. Tenant ACLs protect manifests; content hashes detect corruption. The initial blob store is content-addressed filesystem storage behind `BlobStore`; it is not an S3 implementation. Back up the PostgreSQL journal, object directory and retained workspace storage together. There is no automated retention/GC or recovery-resolution UI yet.

## Effect and OTLP are part of the runtime

The implementation follows [Kit Langton's Effect skill](https://github.com/kitlangton/skills/tree/main/skills/effect): named `Effect.fn` boundaries, scoped services/layers/fibers, tagged failures, Schema decoders, Config, Schedule polling, and Effect-aware tests. The pinned Effect version is **4.0.0-beta.107**, not a stable-release claim. Vendor Promise APIs stop at named adapter effects.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an operator-approved OTLP/HTTP JSON receiver. When absent, nothing is exported. Effect's OTLP layer exports traces, structured logs and metrics with bounded batches and shutdown flush. Incoming validated W3C trace context propagates into durable Work; dispatch and the trusted broker reconnect to that trace. The isolated Executor dependency tree does not export a second telemetry stream. Wide Work events include schema version, Work/legacy-parent IDs, action/catalog, phase/outcome, provider, attempt, queue/elapsed/deadline times, configured limits, call counts, selection score, unknown estimates and rejection reasons.

Wide events deliberately exclude source, arguments, outputs, console logs, credentials and raw vendor errors. Those authorized outputs live in the Work/resource store, not telemetry. Metrics use bounded action/capability/lifecycle/phase dimensions, never tenant/Work IDs. Custom trusted connectors must follow the same disclosure rules when adding spans or errors. OTLP is best-effort operational telemetry, **not a second authoritative journal**. No sampling, retention or security claim is delegated to the model.

The optional Compose `observability` profile supplies the existing collector with memory limiting/batching; see the local startup commands above. It does not publish OTLP externally by default.

When running directly without `DATABASE_URL`, persistent PGlite runs PostgreSQL in-process under `.data/postgres`; use only one process on that directory. The real PostgreSQL path acquires the singleton coordinator lock and does **not** auto-migrate shared databases. Apply `migrations/001_core.sql` only to disposable local data or after explicit approval. The Docker setup explicitly runs its local migrator before starting the API.

## Extending and qualifying the foundation

Add a `CodeBackend`, `EphemeralSandboxBackend` or `PersistentSandboxBackend` implementation and register its correlated candidate capability/lifecycle/profile facts. These are execution contracts within two capabilities, not three products. Native adapters return allocation identity before readiness/materialization; the journal retains identity before fallible initialization. Keep provider effects outside database transactions. Prefer a narrow adapter contract over optional unsupported methods. Add tools with `defineTool` using Effect input/output schemas; Catalog builds Ajv validators and TypeScript descriptors. Changing schema/effect metadata changes the catalog revision; old queued catalog work fails closed rather than resolving a new definition.

Current explicit omissions: independently supervised Sandbox services/previews, HA controllers, vendor price/health ingestion, automatic uncertain-effect reconciliation, provider memory continuity, external object storage, generalized resource retention, OIDC/multi-node callback routing, and production tenant isolation. `/v1/capabilities` advertises unsupported service/preview actions; the API does not accept service declarations and pretend to retain them.

Publication verification: type/build checks and **59 tests across 9 files** passed. The real Docker Compose/MCP journey passed with PostgreSQL 17.6: unauthenticated requests returned 401; native output was exact `forty-two`; MCP output was 11 versus the other tenant's 83. API restart, container recreation and full down/up preserved Work/attempt identity, workspace, credentials and a remote write count of one. Fixture services are integration evidence, not live corporate registry verification. No GitHub deployment workflows are included.

Run `npm run setup:executor`, `npm run check`, `npm test`, and `npm run build`. Tests cover actual Executor/remote MCP isolation and frozen selection, unsupported elicitation, known versus uncertain effects, redirect/endpoint/credential policy, real QuickJS async/limits/clean state, real native artifacts/workspace recreation, all provider client doubles, scheduler feasibility/fairness/atomic claims, rebinding dedupe, publication/seal failures, restart recovery, authenticated HTTP and actual OTLP wire export with disclosure canaries. `test/types.ts` contains negative compile fixtures. No live cloud deployment, shared infrastructure write or production migration is part of these tests.
