# Action Space: durable workspaces and typed execution for managed agents

Working-backwards PR/FAQ · Draft 0.1 · September 10, 2026

> **Implementation status:** Historical proposal. [README](README.md) and [Executor integration](providers/executor/INTEGRATION.md) define the current API. Code execution records one Work with diagnostic MCP calls, not the nested child-Work or business-approval machinery proposed below. Service/preview and broader host APIs remain design material.

> **Current vocabulary:** This is a predecessor proposal; its launch examples are historical, not the current schema or scope. The [current API overview](ARCHITECTURE_ASTRA_XHIGH.md#api-at-a-glance) defines Code execution (`code_execution`/`invocation`, `code.execute`, `code-js-v1`) and Sandbox (`sandbox` with `ephemeral` or `persistent` lifecycle profiles, `sandbox.run`, `sandbox.shell`/`sandbox.read`). The agent API is `execute({code})` with in-program `tools.*`. Compose, Job, and Project are superseded public names; continuity means declared workspace only, never implicit root filesystem or RAM.

**Status:** Product and architecture proposal, not an implemented API. The press release below describes a proposed launch; quotations are illustrative, not customer evidence. API examples are design sketches. Prior-art claims link to public documentation reviewed for this draft; vendor performance claims are not independently benchmarked.

**Recommendation:** Build the execution layer of a managed-agent platform: a durable workspace, a catalog of typed capabilities, and replaceable runtimes. Adopt Cloudflare’s execution ladder as a compute-selection strategy, not a permission hierarchy. Keep the agent harness and conversation history outside every execution runtime.

## 1. Proposed launch press release

### Action Space gives agents the right place to work—and keeps their work when the machine disappears

**Developers can give agents files, code execution, API integrations, browsers, and Linux machines through one typed interface, with explicit permissions and recoverable operation history.**

Today we are introducing Action Space, the execution system for managed agents. Action Space lets developers build agents that begin with inexpensive file and API operations, attach a browser or full development environment when needed, and continue working across interruptions without treating a particular machine as the agent’s identity.

Today, taking an agent from a demo to a dependable service means integrating several different systems. A code sandbox runs Python. A browser service operates websites. A tool gateway connects business APIs. A filesystem stores intermediate work. Each has different credentials, lifecycle rules, failure modes, and ways of returning results. Developers become responsible for answering basic questions: Did that command finish? Where did its files go? Is retrying safe? Can a teammate inspect the result?

Action Space gives each task a durable workspace and scoped access to the capabilities it needs. An agent can inspect a spreadsheet without starting a Linux machine, run a small program to combine API results, attach Python for statistical analysis, or open a browser to work with a service that has no API. Developers define allowed resources and budgets; the platform chooses an eligible runtime without silently widening permissions.

Consider an operations agent asked to investigate discrepancies between invoices and a ledger. It queries approved systems through credential-brokered tools, stores source data in its workspace, and uses a small program to reconcile straightforward records. If the analysis needs a native Python library, it attaches a prepared Linux environment to the same workspace branch. It generates a report and a private preview. A proposed correction to the billing system waits for approval of the exact action. If the reviewer returns tomorrow, the evidence and pending operation are still there, even if the compute has stopped.

“We wanted to build an agent that finishes the investigation, not maintain a machine for every conversation,” says an illustrative design partner. “Now we can see what it used, what it changed, what survived, and what still needs permission.”

Developers integrate through a typed SDK or expose Action Space as tools to an existing agent harness. Files, operation records, and artifacts are durable according to an explicit retention policy. Compute is allocated on demand; idle storage and reserved capacity are billed separately. Private previews let people inspect the agent’s output without making development services public.

The proposed private beta includes durable workspaces, bounded JavaScript execution, approved package resolution, a credential-brokered tool catalog, managed browsers, and prepared Linux sandboxes. Desktop control and customer-hosted runners follow after the same lifecycle and security contracts pass conformance testing.

## 2. Customer FAQ

### Who is this for, and what job are they hiring it to do?

The initial customer is a team building managed coding, research, data-analysis, or operations agents. Its agent loop works, but reliable execution across files, APIs, browsers, and machines requires too much bespoke infrastructure.

The job is: **“Give my agent the least expensive eligible execution environment, keep its acknowledged work, and make every action inspectable and governable.”**

The buyer is the platform team. The direct API consumers are both application developers and agents. The human reviewer needs artifacts, diffs, live previews, and approvals rather than infrastructure dashboards alone.

Start with coding and analytical workflows: their local outputs can be inspected before publication. Autonomous high-stakes transactions are not the initial wedge.

### Is this a managed-agent platform or a sandbox provider?

It is the execution subsystem of a managed-agent platform, independently usable through an API.

| Managed-agent platform owns | Action Space owns | Runtime provider owns |
| --- | --- | --- |
| Model choice, prompts, agent loop, context construction, conversation/session log, scheduling, delegation | Workspaces, runtime attachment lifecycle, operation ledger, tool contracts, enforcement, artifacts, previews, execution budgets | Compute placement and runtime-specific primitives under a declared contract |

Action Space does not decide what the user wants, summarize conversations, or create a competing agent framework. It emits execution events that the platform links into its own session log. Scheduling wakes the harness or submits work; retaining a workspace does not require a running harness or machine.

### Why not give every agent a VM?

A VM is an excellent compatibility target, but an expensive default for reading a file or composing three API calls. It also encourages developers to put session state, credentials, processes, and outputs in one failure domain.

Use a VM when the task needs POSIX semantics, native dependencies, long-lived processes, or a desktop. Do not require one before the first useful action. Conversely, do not force a complex Python or build workload through a constrained JavaScript runtime just to stay on a lower tier.

### What does the execution ladder look like?

| Rung / capability | Typical work | State and limitations |
| --- | --- | --- |
| Workspace | Read, write, edit, search, diff, store structured task state | Durable versioned data; no agent-controlled OS process |
| Bounded JavaScript | Transform JSON, combine API calls, compute summaries | Fresh invocation heap; explicit workspace and tool bindings; no ambient network |
| JavaScript + packages | Parse documents, validate data, use compatible libraries | Same runtime boundary; pinned package graph; not arbitrary Node.js compatibility |
| Browser | Navigate, inspect accessibility tree, interact, download, screenshot | Independent browser session; explicit origins and authentication profile |
| Linux sandbox | Python, Git, compilers, tests, services, arbitrary approved toolchains | POSIX working tree; explicit publication to durable workspace |
| Desktop / attached computer | GUI-only applications and customer-owned devices | Separate control lease; device-specific capabilities and recovery limits |

These are not mutually exclusive or a strictly nested set. A browser can coexist with Linux; an API connector is usable from several runtimes. Package support is an extension of JavaScript, not necessarily a new allocation. A GPU is a resource requirement, not “tier 6.”

**The ladder answers where code runs. Policy answers what it may access.** A browser logged into a bank has more consequential authority than an offline Linux machine. Moving up the ladder never grants credentials, egress, a public preview, or permission to make external changes.

### What happens when an agent needs something more powerful?

The agent requests a capability with a reason, or directly submits an operation whose requirements are known. Action Space evaluates compatibility, locality, policy, budget, and startup cost. It returns an eligible attachment, an approval request, or a structured explanation of why none is available.

Routing uses declared requirements—not speculative execution of the same program across progressively larger runtimes. An unsupported native package produces a compatibility error before execution when detectable. A runtime error is not permission to retry elsewhere.

An attachment does not migrate a JavaScript heap into Python or turn a browser session into a desktop. The agent passes durable file versions, artifacts, and validated JSON between them.

### What persists?

| State | Contract |
| --- | --- |
| Workspace files and structured state | Acknowledged workspace commits survive harness and runtime replacement within retention policy |
| Operation records and published artifacts | Independently durable; retrievable without waking compute |
| Linux working-tree changes | Local until publication or a runtime checkpoint; publication returns a workspace version, while a machine checkpoint returns a provider-bound restore handle |
| Installed toolchains | Recreated from a pinned template; interactive installs need a runtime checkpoint or recipe update |
| JavaScript variables | Do not survive invocations; explicitly save needed values |
| Processes / REPL memory | Survive only under an advertised, successfully completed memory-preserving pause contract |
| Browser cookies / profile | Persist only if explicitly retained; encrypted and access-controlled as credentials |
| External effects | Remain in the external system; no workspace restore can unsend a message or undo a payment |

A memory snapshot is an optimization and optional continuity feature, not the source of truth for a task. Socket connections, expiring logins, and remote transactions still need reconciliation after wake.

### Can people inspect or take over the agent’s work?

Yes. Artifacts have immutable versions and provenance. A live service can receive a private authenticated preview tied to a service identity, with an expiry and audience. A URL can be configured before a service is ready; the API exposes both facts separately.

Terminal and desktop control require an explicit lease. Human takeover revokes or suspends the agent’s mutation/control lease; read-only observation may continue. The handoff and any resulting workspace checkpoint become execution events. Preview authorization is separate from the previewed application’s own login.

### What does this cost?

Meter active runtime usage, retained storage, browser duration, data transfer, and any reserved capacity separately. Show per-task and per-operation attribution. Do not advertise “free when idle” unless storage and reservation costs are explicitly excluded or included in a defined allowance.

The platform reserves budget before dispatch and enforces CPU, memory, wall-time, output, and concurrency limits at the executor and broker. A code-mode loop does not get unlimited tool calls because it fits in one model tool invocation. External API charges may require estimates and conservative reservations; they are not always precisely controllable.

## 3. Prior art: what to borrow and what to change

These are documented behaviors, not claims about private vendor internals or a complete competitive feature inventory.

| Source | Documented behavior | Design consequence |
| --- | --- | --- |
| [Cloudflare Project Think][think] | Workspace → Dynamic Worker → npm → browser → sandbox; explicit bindings; independently usable primitives; experimental Think harness | Borrow progressive compute allocation and capability bindings. Keep the execution service independent of the harness. Treat browser and Linux as composable capabilities rather than permission ranks. |
| [Amp Orbs][amp-orbs], [customization][amp-custom], [portals][amp-portals] | Per-thread isolated machine; prepared project snapshots; setup/resume hooks; supervised services; authenticated previews; wake on interaction | Borrow the complete reviewable work environment. Separate reusable preparation from runtime identity, services from shell-child lifetimes, and preview existence from readiness. Public docs establish behavior, not Amp’s complete scheduler/storage architecture. |
| [Executor][executor], [MCP proxy][executor-proxy], [policies][executor-policy] | Unified tool catalog over MCP/OpenAPI/GraphQL; code-mode discovery; host-side credential attachment; allow/approve/block policies | Borrow typed discovery and one policy path across calling surfaces. Executor is primarily an integration layer, not evidence of a durable general-purpose machine abstraction. Imported effect hints are useful defaults, not proof of safety. |
| [Executor Cloudflare deployment][executor-cf] | QuickJS runs tool code inside a Worker; D1 storage; single-tenant deployment behind Cloudflare Access | Lightweight code mode need not allocate a Linux sandbox. This is a documented deployment architecture, not a claim that every Executor deployment uses the same runtime. |
| [Anthropic architecture][anthropic-architecture], [overview][anthropic-overview] | Separates session log, harness, and sandbox; lazy provisioning; independent failures; managed and self-hosted environments | Borrow the separation of control and execution. Replace a generic string-only tool boundary in our public API with typed results, operation identity, recovery information, and artifacts. |
| [Anthropic self-hosting][anthropic-selfhost] | Environment workers claim queued work and return results; execution stays local but tool inputs/outputs reach Anthropic; custom-tool approvals belong in custom code | Provide an outbound worker integration, but keep queue credentials outside untrusted processes. A self-hosted runtime alone does not establish end-to-end data residency. Integration must enforce our policy even for custom tools. |
| [E2B persistence][e2b-persistence], [snapshots][e2b-snapshots] | Distinguishes pause/resume from reusable snapshots; supports memory and filesystem preservation; network clients must reconnect | Specify checkpoint contents, continuity, and restore compatibility explicitly. Do not reduce all providers to a boolean `persistent`. |
| [Modal snapshots][modal-snapshots] | Separate directory, filesystem, and experimental memory snapshots with differing retention and restore limits | Keep provider capabilities and checkpoint expiry visible. A portable filesystem version is different from a provider-specific machine checkpoint. |

### Where does the proposal depart from the prior art?

The product hypothesis is that developers will pay for **consistent state, authority, and recovery semantics across execution backends**, not merely a common `exec()` method.

Three deliberate differences:

1. **Workspace identity outlives compute identity.** An agent can inspect its output without restoring the original machine.
2. **Every execution has a typed, durable outcome.** “Unknown whether it happened” is a first-class result, not disguised as a safe-to-retry transport error.
3. **Every access path respects the same grants.** Code mode, direct tools, browser access, shell egress, and human control cannot bypass policy by choosing another interface. Where semantic control is impossible, the system exposes coarse authority honestly or denies that mode.

These are proposed guarantees to validate, not assertions that all competitors lack them.

## 4. Technical FAQ

### What are the core objects?

Keep six customer-facing resource types:

| Resource | Meaning |
| --- | --- |
| `Workspace` | Durable namespace of files, versioned branches, and JSON task state; independent of any model session |
| `EnvironmentSpec` | Immutable version of a prepared runtime recipe, supported capabilities, and resource requirements |
| `Attachment` | A workspace’s connection to one allocated runtime or existing runner; includes resolved capabilities, location, generation, and lifecycle |
| `Operation` | Durable record of an accepted action, its dispatch attempts, outputs, and effect status |
| `Grant` | Server-enforced authority scoped to principal, resources, operations, expiry, and constraints |
| `Artifact` | Immutable output bytes plus type, provenance, access policy, and retention |

Checkpoints, browser sessions, processes, services, and previews are typed handles owned by attachments or operations. Their retained metadata can outlive the runtime. A checkpoint additionally records provider compatibility and expiry. IDs are references, not bearer capabilities: knowing an ID never authorizes access.

Many agent sessions can refer to one workspace with separate grants. One session can use several attachments. Avoid sharing a writable branch by default; delegate branches or disjoint resources explicitly.

### What is the architecture?

```diagram
┌─────────────────────────────────────────────────────┐
│ Managed-agent platform                              │
│ Harnesses · durable session log · scheduler · review │
└──────────────────────────┬──────────────────────────┘
                           │ SDK / agent tools / MCP
┌──────────────────────────▼──────────────────────────┐
│ Action Space control plane                          │
│ Schemas + catalog · policy + approvals · budgets     │
│ Operation ledger + outbox · attachment reconciler   │
└──────────┬────────────────┬────────────────┬────────┘
           │                │                │
┌──────────▼─────────┐ ┌────▼──────────┐ ┌───▼─────────────┐
│ Durable data      │ │ Tool broker   │ │ Runtime gateway │
│ Files + versions  │ │ Credentials   │ │ Leases + fencing│
│ State + artifacts │ │ External APIs │ │ + adapters      │
└───────────────────┘ └───────────────┘ └───┬─────────────┘
                                           │
             ┌──────────────┬──────────────┼──────────────┐
       ┌─────▼─────┐ ┌──────▼─────┐ ┌─────▼─────┐ ┌──────▼─────┐
       │ JS isolate│ │ Browser    │ │ Linux VM  │ │ BYO runner │
       └───────────┘ └────────────┘ └───────────┘ └────────────┘
```

The isolate receives callable bindings to authorized workspace and broker operations. Linux and browser executors reach equivalent scoped gateways through authenticated channels. Untrusted runtimes cannot reach provider admin APIs, the secrets vault, or tenant-wide queue credentials.

A practical first implementation uses Postgres for metadata, workspace heads, policy, operation records, and a transactional outbox; object storage for immutable blobs and manifests; existing isolate, browser, and VM providers for execution. Trusted workers reconcile desired state against observed provider state. Separate services only where trust or scaling requires it; this does not need to start as a dozen microservices.

### What makes the API strongly typed?

Use one versioned schema source to generate TypeScript/Python SDKs, wire validation, agent tool input schemas, and catalog descriptions. Core APIs have explicit tagged unions and bounded structured errors. JSON Schema is the wire contract; TypeScript types alone do not enforce anything at runtime.

Validate input before dispatch and output before exposing it as a typed success. Imported tools with no trustworthy output schema return `unknown` or preserved content blocks, not invented types. A malformed output after an external write is a contract failure **after possible execution**; it must not cause an automatic repeat.

A capability manifest declares semantic support, not just method names:

```ts
type Capability =
  | { kind: "workspace"; api: "v1"; writes: "versioned" }
  | { kind: "javascript"; api: "v1"; packages: "none" | "bundled" }
  | { kind: "browser"; api: "v1"; observe: ("a11y" | "screenshot")[] }
  | { kind: "process"; api: "v1"; os: "linux"; pty: boolean }
  | { kind: "computer"; api: "v1"; input: ("pointer" | "keyboard")[] };

type Continuity =
  | { kind: "recreate"; workspaceVersion: string }
  | { kind: "filesystem"; checkpointId: string; expiresAt: string }
  | { kind: "memory"; checkpointId: string; expiresAt: string;
      compatibilityKey: string; reconnectRequired: true };
```

Discovery identifies what a provider can implement. Grants identify what this caller may use. Negotiation returns their intersection plus resolved limits. Missing required semantics fail explicitly; no silent fallback from memory continuity to filesystem-only recovery.

Generic envelopes are useful for transport, but application code should see concrete operations such as `process.start`, `browser.observe`, and `workspace.commit`, not an untyped `execute(name, object)` everywhere.

### What would a developer write?

The following sketches the trusted host SDK. Mutation methods return durable operation handles; `result()` waits for a typed success or raises a structured non-success. The host persists stable request keys before submission and can reconnect using operation IDs. Example IDs refer to previously configured immutable specs and policies. `inputBundle` is a previously uploaded, authorized archive containing `analyze.py` and its input data; the script produces `/workspace/report.html`. Archive import validates paths and rejects entries that escape the workspace.

```ts
const workspace = await env.workspaces.create({
  requestKey: "investigation-482-workspace",
  seed: { artifactId: inputBundle.id },
  retentionDays: 30,
}).result();

// Only the trusted platform can issue grants, within its own authority.
const grant = await env.grants.issue({
  requestKey: "investigation-482-grant",
  subject: { agentRunId: "run-482" },
  workspaceId: workspace.id,
  policyId: "invoice-investigator-v3",
  budget: { maxUsd: "2.00", maxConcurrentOperations: 4 },
  expiresAt: "2026-09-12T00:00:00Z",
}).result();

const linux = await env.attachments.acquire({
  requestKey: "investigation-482-python",
  workspaceId: workspace.id,
  branch: "main",
  grantId: grant.id,
  specId: "python-analysis-v7",
  requires: [{ kind: "process", api: "v1", os: "linux", pty: false }],
  placement: { region: "us-east", provider: "auto" },
}).result();

const analysis = env.process.start({
  requestKey: "investigation-482-analyze-v1",
  attachmentId: linux.id,
  generation: linux.generation,
  argv: ["python", "analyze.py"],
  cwd: "/workspace",
  limits: { wallMs: 120_000, outputBytes: 1_000_000 },
});

for await (const event of analysis.events({ after: savedCursor })) {
  // Persist the cursor with the consumed event in the host's session store.
  await recordExecutionEvent(event);
}

const result = await analysis.result();
if (result.exitCode !== 0) throw new Error("Analysis did not succeed");

const published = await env.workspaces.publish({
  requestKey: "investigation-482-publish-v1",
  attachmentId: linux.id,
  generation: linux.generation,
  expectedHead: linux.baseVersion,
}).result();

// Publishing first makes the report independent of the machine's lifetime.
const report = await env.artifacts.create({
  requestKey: "investigation-482-report-v1",
  source: { workspaceId: workspace.id,
            version: published.version, path: "/report.html" },
  mediaType: "text/html",
}).result();
```

`argv` avoids accidental shell interpolation; a separate explicit `shell` operation supports scripts when needed. Arbitrary shell commands cannot have their semantic effects inferred reliably from their text. Process success means the process exited and its result was recorded—not that its local files were durably published.

### How do agents use this API as tools without receiving hundreds of schemas?

Offer two equivalent surfaces, backed by the same validation and enforcement:

1. **Direct tools** for common operations and models that prefer conventional tool use: workspace read/edit/search, process start, operation inspect, browser observe/act, artifact read. Load capability-specific tools when attached, where the harness supports it.
2. **Code mode** for discovery and composition: `catalog.search`, `catalog.describe`, and `code.run`, plus small `operation.inspect` and `operation.cancel` tools. Expose a fixed surface through MCP or the harness’s native tool format.

Code mode is a bounded JavaScript runtime, not a shell and not the host application’s JavaScript context. Catalog discovery is scoped to authorized resources. `describe` returns exact versioned TypeScript declarations, JSON Schemas, examples, effect metadata, and limits. Pin the catalog version for a program; authorize again on every actual call.

```ts
// Agent-authored source passed to code.run after catalog discovery.
// These modules are generated bindings, not arbitrary npm imports.
import { listInvoices } from "tools/billing@v3";
import { writeJson } from "workspace@v1";

const invoices = await listInvoices({ status: "overdue", limit: 100 });
const candidates = invoices.items.filter(i => i.balanceCents > 50_000);
const saved = await writeJson({
  path: "/overdue-candidates.json",
  value: candidates,
  ifAbsent: true,
});
return { count: candidates.length, version: saved.version };
```

The enclosing `code.run` request carries a grant, request key, wall/CPU limits, output budget, and pinned catalog version. No raw credentials appear in the code. Each nested call has its own ledger entry and policy decision. Large outputs become artifact references with a bounded preview, declared truncation, and pagination rather than flooding the model context.

Agent-generated programs are not automatically durable workflows. If an isolate dies or a call requires approval, retain completed child results and the pending action, then return control to the harness. Approval dispatches only that pending action; it does not rerun the program. The agent can submit a new program referencing prior results. Durable arbitrary JavaScript continuation is a separate product, not an implicit promise of code mode.

### What is the minimal API surface?

| Namespace | Core methods | Important contract |
| --- | --- | --- |
| `workspaces` | create, read, search, commit, publish, fork, merge, state.get, state.compareAndSet | Explicit versions and conflicts; JSON state uses the same workspace version boundary |
| `catalog` | search, describe | Versioned, authorized discovery; unknown upstream output stays unknown |
| `code` / `tools` | run / invoke | Bounded computation; per-call grants, effects, and result validation |
| `attachments` | acquire, inspect, pause, resume, release | Returns resolved capabilities and generation; lifecycle commands are operations |
| `process` | start, stdin, signal, inspect | Durable logical process handle, explicit PTY mode, cursor-based output |
| `browser` | open, observe, act, close | Session-bound observations and stale-target errors |
| `computer` | observe, act, requestControl, releaseControl | Exclusive control lease and frame-bound coordinates |
| `services` / `previews` | ensure, inspect, logs, stop / create, revoke | Supervisor ownership, readiness, audience, expiry |
| `checkpoints` | create, inspect, restore | Filesystem vs memory; consistency level, compatibility, expiry |
| `operations` | get, events, cancel | Durable status, reconnectable streams, no implication that cancel undoes effects |
| `grants` / `approvals` | request, inspect, issue, revoke / decide | Agents may request; only independently authorized actors grant or approve |
| `artifacts` | create, read, list | Immutable content, provenance, access control, explicit retention |

The wire API can use `POST /v1/operations` with a tagged action union and `GET /v1/operations/{id}` plus SSE events. SDK namespaces are generated ergonomic views of that contract. Admission errors such as malformed input or unauthorized IDs return before an operation is accepted. Accepted mutations return `202` with a durable operation ID. Reads can return directly.

Requests specify an API version. Method schemas have stable versions; provider-specific extensions live in explicit namespaces. Unsupported requirements return `CAPABILITY_UNAVAILABLE` with unmet requirements, not a vague provider error.

### How do files move between the workspace and Linux?

**Use versioned checkout and publish first; do not start with transparent bidirectional sync.**

The workspace stores immutable content blobs and manifests. A transaction advances a branch head to a new manifest. A Linux attachment materializes one version into a local POSIX tree, preserving supported path types and executable bits. Unsupported filesystem entries fail export explicitly. Large files transfer directly through scoped data-plane access, not through the model.

While an attachment holds a branch’s write lease, mutations on that branch route to its working tree or are rejected as busy. Direct workspace reads remain pinned to the last published version unless the caller explicitly requests a live attachment read. There is no illusion that the two views are identical before publication.

`publish` quiesces writers, uploads changed blobs, and atomically advances the head using `expectedHead`. It returns a version only after durable metadata and blobs are available. A stale writer receives `CONFLICT`; its candidate manifest remains available for inspection. Never silently choose last-writer-wins for code or task state.

Processes and services that can write the tree must be stopped, frozen, or cooperatively flushed before capture. Filesystem-consistent capture is not necessarily application-consistent: SQLite databases and similar workloads need appropriate hooks. Failed publication leaves the previous workspace head intact and reports local uncommitted changes as at risk.

Parallel agents normally fork from the same version. Merge produces an explicit change set and conflicts; merging files does not merge external effects, browser state, or running processes. Shared caches are separate from authoritative workspace data.

### What is the lifecycle and failure contract?

Attachments expose observed state and desired state separately:

```diagram
requested → provisioning → ready → pausing → paused
                              ▲                │
                              └── resuming ◀───┘

Any live state → lost / failed → explicit restore or replacement
Any live state → releasing → released
```

The provider adapter reports whether a failed pause left the machine running. `paused` is not reported until its required checkpoint is committed. A failed memory-preserving pause does not silently downgrade continuity. Resume reports a new generation, renewed grants, restored state, and required reconnections. Stale generation handles fail.

Auto-pause waits for inactivity, not merely a quiet agent conversation. Active processes, desktop control, and preview requests acquire bounded activity leases. Long-running services follow an explicit idle policy; they do not keep machines alive forever accidentally. Runtime release does not delete workspace or artifact data. Deletion is separately authorized and follows retention rules.

An operation uses a state machine and a separate effect disposition:

```ts
type OperationState<T> =
  | { state: "queued" }
  | { state: "awaiting_approval"; approvalId: string }
  | { state: "running"; attempt: number }
  | { state: "succeeded"; output: T }
  | { state: "failed"; error: ExecutionError }
  | { state: "cancelled"; effects: EffectDisposition }
  | { state: "indeterminate"; reconciliationId: string };

type EffectDisposition = "none" | "possible" | "confirmed";
type ExecutionError = {
  code: "CAPABILITY_UNAVAILABLE" | "POLICY_DENIED" | "BUDGET_EXCEEDED"
      | "CONFLICT" | "STALE_HANDLE" | "RUNTIME_LOST" | "DEADLINE_EXCEEDED"
      | "CONTRACT_VIOLATION" | "UPSTREAM_FAILURE";
  effects: EffectDisposition;
  nextAction: "correct_input" | "request_grant" | "inspect_operation"
            | "reconcile" | "retry_safe";
  message: string;
};
```

Operation success is defined per method. A successful process execution may return a nonzero exit code; that is program failure, not evidence that dispatch failed. An awaiting-approval operation has not dispatched that action, although earlier actions in the same code-mode program may already have completed.

**Deduplicated admission is not exactly-once execution.** Store request keys and payload hashes in a tenant/principal-scoped namespace before dispatch. Same key and payload returns the same operation; a different payload conflicts. Retain deduplication records for a documented window and compact them into key tombstones when detailed results expire, so an expired key is rejected rather than treated as a fresh retry.

A transactional outbox prevents accepted operations from being lost between database commit and queueing. Workers use leases and fencing generations. Gateways and storage reject stale generations; a guest-local lock alone is not fencing. If a partitioned worker cannot be fenced from relevant effects, do not automatically redispatch a non-idempotent action.

| Failure | Required behavior |
| --- | --- |
| Client loses response after accepted submission | Resubmit with the same key or inspect the operation; do not create a second action |
| Harness crashes | Replacement harness reads the platform session log and retrieves existing operations |
| Executor dies before dispatch is confirmed | Reconcile dispatch journal/provider state; do not infer “never ran” from missing output |
| External write succeeds but response is lost | Mark indeterminate; use upstream idempotency or read-back reconciliation; never blindly repeat |
| Output validation fails after dispatch | Preserve bounded raw evidence securely; report contract violation and effect disposition |
| Cancel races with completion | Record the actual result; cancellation is a request, not rollback |
| SSE disconnects | Resume by event cursor; events are at-least-once and consumers deduplicate by event ID |

The operation ledger is authoritative; only a recorded terminal result establishes completion. A broken stream is not a failed operation. An indeterminate record may later resolve through reconciliation, with that transition also recorded. Event retention is explicit, with `CURSOR_EXPIRED` and snapshot recovery rather than silent loss of history.

### How are credentials and approvals enforced?

Separate the trusted executor controller from all agent-authored code. A broker resolves credentials outside the runtime and attaches them only to approved outbound requests. Runtimes get narrow, revocable channels or short-lived workload identity—not tenant-wide API keys. A grant ID supplied by the model is always checked against the authenticated principal.

Permission is the intersection of tenant policy, acting user authority, session grant, resource policy, and current operation constraints. Forking an attachment or delegating work cannot amplify authority. Revocation is checked at every gateway action; active direct egress is cut off when revocation requires it. Already-completed effects cannot be revoked.

An approval binds an immutable action ID to the normalized input hash, tool/schema version, destination connection, acting identity, expiry, and relevant resource preconditions. A later policy revocation still blocks execution. Changed arguments or stale preconditions require a new approval. Approving an opaque script is not equivalent to approving every future external action it might produce.

Imported HTTP methods, GraphQL mutation labels, and MCP effect hints are untrusted classification inputs. Unknown or administrator-unreviewed tools default to approval or denial. Even read access can disclose sensitive data; a `GET` label does not establish harmlessness or authorization.

Network enforcement must be outside a root-capable guest: default-deny egress; controlled DNS and redirects; private/metadata address protection; destination-aware credential injection; isolated tenant channels. A local filesystem path check is not a security boundary if unrestricted shell can bypass it. Read-only resources need actual read-only mounts or equivalent isolation.

Semantic approvals cannot be guaranteed for arbitrary browser clicks or shell traffic allowed directly to an authenticated application. In strict mode, route consequential writes through brokered typed tools, use read-only application credentials, or require human control of that application. If broad direct access is authorized, clearly report that the grant covers those actions at the network/session level, not per-business-action inspection.

Browser cookies, desktop sessions, snapshots, and output data are sensitive even when API tokens never reach the sandbox. Restrict profile export, protect retained state, and prevent untrusted previews from sharing the control plane’s origin or credentials. Redaction helps logs but cannot make arbitrary sensitive inputs safe to disclose to a model.

### How do browser and computer tools stay grounded?

`browser.observe` returns an observation ID, document/navigation generation, accessibility nodes with opaque references, and an optional screenshot artifact. `browser.act` requires that observation ID and node reference. If navigation or relevant document state changed, return `STALE_HANDLE` and require re-observation rather than guessing.

`computer.observe` returns a frame ID, display ID, dimensions, scale, timestamp, and screenshot artifact. Pointer actions bind coordinates to that frame and an exclusive control lease. Keyboard, clipboard, uploads, downloads, and screen recording are separate permissions. Expired frames or changed display geometry require a new observation.

These checks reduce stale-target errors; they cannot atomically bind a screenshot to a remote business transaction. For irreversible actions, use the approval and application-level restrictions above. A real customer-owned runner is also a different trust class from a disposable managed VM; it must never be selected as a silent fallback.

### How do templates, services, and checkpoints work?

Take Amp’s separation of setup, wake repair, and supervised services. An immutable template pins its base image, toolchains, dependency locks, build inputs, architecture, and required health checks. Cache keys include those inputs. Build artifacts must not include personal credentials or authenticated browser state.

Package resolution verifies pinned versions and integrity hashes. Bounded-JS package loading rejects native addons and install scripts; libraries requiring those features need an approved Linux template. Template builds execute in a separate restricted build environment, with short-lived access to approved registries. Shared caches are partitioned by trust boundary and validated before reuse.

Activation injects fresh scoped identity and performs bounded idempotent repair. Critical readiness checks gate attachment readiness; optional background work is reported separately. `services.ensure` creates a stable service identity with a desired command, environment, health probe, restart policy, and idle behavior. Services belong to the runtime supervisor rather than the agent tool process.

Checkpoints distinguish workspace versions, filesystem checkpoints, and memory checkpoints. A restore response reports exactly what was restored and what was recreated. Machine checkpoints are provider/architecture/runtime-version specific unless an adapter proves otherwise. Default forks use workspace or filesystem state, not copied live processes that could repeat external writes. Any future memory fork starts fenced from external access until a new identity and grants are installed.

### How does this fit Anthropic Managed Agents or another harness?

Provide an adapter that maps the harness’s tool-call ID to one Action Space request key, forwards structured progress, and posts a bounded result plus artifact references. On harness recovery, recover the same mapping before executing anything.

For Anthropic Managed Agents, the documented integration paths include custom tools and self-hosted environment workers. Start with a fixed set of custom discovery/execution tools backed by Action Space, or a trusted environment worker that delegates built-in process/file operations to Action Space attachments. Do not assume dynamic catalog changes can add new native tools to an already-running session; code-mode discovery keeps the declared tool set stable. Enforce approvals in our gateway because Anthropic documents that its custom-tool path does not apply the built-in permission policies.

Keep the worker’s queue and platform credentials outside untrusted execution. The public architecture article describes credential separation as a principle, while current self-hosted examples can forward worker credentials into a per-session container. Those are different trust boundaries; our adapter must explicitly choose and enforce the stronger external-controller boundary.

Execution locality does not imply model-input locality. Tool results, screenshots, logs, and file excerpts may leave the customer environment for inference. Placement policy must separately constrain execution, durable storage, telemetry, and model-visible output. Unsupported combinations are rejected.

### How do we avoid an abstraction that hides provider differences?

Define a provider protocol with provisioning reconciliation, capability negotiation, operation dispatch/inspection, lifecycle, and artifact transfer. An adapter advertises concrete semantics and passes conformance tests for the subset it supports. A provider without memory snapshots can still support the baseline Linux contract; it must reject requests requiring memory continuity.

Provider selection minimizes expected eligible cost including startup, transfer, and reuse—not a hard-coded ranking. Never migrate an active external session merely because another provider is cheaper. Pin the provider for nonportable state; export portable workspace data at explicit boundaries.

Build the typed contract, operation ledger, policy/broker, and workspace versioning. Buy initial compute and browser isolation. Avoid building a hypervisor or distributed POSIX filesystem in the first release.

## 5. Launch scope and falsifiable tests

### What ships first?

**Private beta:** one home region per workspace; TypeScript SDK and fixed MCP tools; workspace file/JSON operations; bounded JS with approved pure-JS packages; a small set of well-specified API connectors; one managed Linux adapter; one browser adapter; durable operations; approvals; artifacts and private service previews. Serial branch mutation, explicit checkpoint/publish, and explicit process-loss reporting are acceptable.

**After contract validation:** Python SDK, branch merge UX, desktop control, a second Linux provider for portability testing, and outbound customer-hosted runners. Memory pause/resume is opt-in only for adapters whose continuity and revocation semantics pass tests.

**Non-goals:** model hosting, a new agent loop, arbitrary durable JavaScript workflows, exactly-once external effects, transparent cross-provider process migration, universal POSIX semantics in the workspace service, unrestricted npm/Node compatibility, or autonomous approval of unknown business actions.

### How will we know the product works?

Run the same task suite through an always-on VM baseline and Action Space, with the same model and inputs. Measure successful reviewed outcomes, cost per completed task, model/tool overhead, time to first useful action, escalation frequency, recovery losses, and approval latency. A cheaper individual call is not a win if task completion gets worse.

Proposed beta exit criteria—not measured results or customer SLAs:

| Test | Required observation |
| --- | --- |
| Read/search/report task requiring no OS | Completes with no VM allocation; allocation is visible in the ledger |
| JS → Python → browser workflow | Shares exact published input versions and returns inspectable artifacts |
| Lost client response and repeated same request key | One logical operation; no second admitted action |
| Harness crash during a running build | New harness reattaches to the operation and receives its final result |
| Provider loss before local files are published | Last committed version survives; unpublished state is explicitly reported lost or recoverable |
| Fault after an external write but before response persistence | Indeterminate outcome or successful reconciliation; no blind retry |
| Two agents publish from the same base | One head update wins; the other gets an explicit conflict with its candidate retained |
| Grant revoked while runtime is paused | Resume cannot reuse old authority; memory restore cannot bypass the broker |
| Package, script, or page attempts metadata access / secret exfiltration | Enforcement blocks prohibited paths across every enabled access surface |
| Navigation or desktop geometry changes before action | Stale observation rejected; no click at guessed coordinates |
| Preview created while service health fails | API/UI says configured but not ready; no false success |
| Workspace/artifact retention expires | Data is inaccessible and lifecycle cleanup follows documented deletion windows |

Use chaos tests around every dispatch/checkpoint boundary, adapter conformance tests, and an external security assessment before broad multi-tenant availability. Benchmark startup separately from queueing and user code. Initial planning targets are p95 under 250 ms for a small same-region workspace operation, under 1 s for a warm bounded-JS start, and under 10 s for a prepared Linux attachment, excluding user initialization and oversized transfers. Validate or revise these before advertising them.

### What could invalidate this strategy?

- **Routing and transfer overhead exceed compute savings.** Measure end-to-end tasks; retain an explicit “stay on this Linux attachment” choice and reuse prepared environments.
- **Agents struggle with explicit publish boundaries.** Put safe checkpoint boundaries in host helpers and return published versions prominently. Do not conceal inconsistent state with silent synchronization.
- **Most customers need only a single sandbox provider.** Test willingness to pay for the durable state/security/review layer before investing in many adapters.
- **Native browser or OS permissions defeat promised action-level controls.** Restrict supported authority profiles and explain the limits instead of claiming complete semantic enforcement.
- **Provider-specific features dominate the contract.** Keep a narrow portable baseline and explicit extensions, and prove it against a second adapter before calling it portable.

### Which decisions need customer validation next?

1. Is the first paid workload coding, data analysis, or business operations? This decides initial templates and connectors.
2. Do customers need filesystem recovery, memory continuity, or both—and will they pay for retained memory state?
3. Are explicit publish/checkpoint boundaries acceptable, or is live shared state truly necessary?
4. Which actions need exact approvals, and which can use a coarse resource/session grant?
5. Is customer-hosted execution a launch requirement, or can it follow a managed beta?

The recommended starting point is coding and analytical agents, filesystem-first recovery, serial writable branches, brokered external writes, and managed compute. This tests the unified execution contract without requiring a new workflow engine or transparent distributed filesystem.

## Sources

Public sources reviewed September 10, 2026. This is documentation-based research, not an implementation audit or vendor benchmark. Preview APIs and provider retention rules may change.

- [Cloudflare: Project Think and the execution ladder][think]. Describes the conceptual ladder, bindings, code mode, and the experimental harness.
- [Amp: Orbs][amp-orbs], [Customizing Orbs][amp-custom], and [Portals][amp-portals]. Establish lifecycle preparation, identity timing, supervision, review, and wake behavior.
- [Executor product overview][executor], [MCP Proxy][executor-proxy], [Policies][executor-policy], and [Cloudflare deployment][executor-cf]. Establish catalog, credential brokerage, policy, and one lightweight runtime implementation.
- [Anthropic: Decoupling the brain from the hands][anthropic-architecture]. Architectural account of session/harness/sandbox separation; its latency improvements are vendor-reported and not used as our forecast.
- [Claude Managed Agents overview][anthropic-overview], [Self-hosted sandboxes][anthropic-selfhost], and [Self-hosted security model][anthropic-security]. Establish current integration paths and shared-responsibility limits.
- [E2B persistence][e2b-persistence] and [snapshots][e2b-snapshots]. Establish pause vs reusable checkpoint semantics and network reconnection requirements.
- [Modal sandbox snapshots][modal-snapshots]. Establish separate filesystem/directory/memory contracts and retention/compatibility limits.

[think]: https://blog.cloudflare.com/project-think/#the-execution-ladder
[amp-orbs]: https://ampcode.com/docs/orbs
[amp-custom]: https://ampcode.com/docs/orbs/customizing
[amp-portals]: https://ampcode.com/docs/orbs/portals
[executor]: https://executor.sh
[executor-proxy]: https://executor.sh/docs/mcp-proxy.md
[executor-policy]: https://executor.sh/docs/concepts/policies.md
[executor-cf]: https://executor.sh/docs/hosted/cloudflare.md
[anthropic-architecture]: https://www.anthropic.com/engineering/managed-agents
[anthropic-overview]: https://platform.claude.com/docs/en/managed-agents/overview
[anthropic-selfhost]: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
[anthropic-security]: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes-security
[e2b-persistence]: https://docs.e2b.dev/sandbox/persistence
[e2b-snapshots]: https://e2b.dev/docs/sandbox/snapshots
[modal-snapshots]: https://modal.com/docs/guide/sandbox-snapshots
