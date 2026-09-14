# Amp Orbs: implementation evidence and reconstructed service boundaries

Research note · September 2026

> **Publication status:** Background research, not Action Space's implementation contract or a vendor integration guarantee. See [README](README.md) and [Executor integration](providers/executor/INTEGRATION.md) for shipped behavior. Private guest service names, command-line settings, listener details and operational identifiers have been omitted; public sources and qualified architectural conclusions are retained.

## Bottom line

**Amp Orbs are an Amp-managed execution product built on E2B microVM infrastructure, with an Amp headless executor running inside the guest.** This is supported by an explicit Amp documentation reference to “E2B microVM orbs” and by direct inspection of this orb, including the installed E2B `envd` binary's Go module identity.

The strongest reconstruction has three distinct boundaries:

1. **Amp thread/orb lifecycle management:** associates a thread with an executor, selects project preparation, handles activation, idle policy, wake, credentials, previews, and review data.
2. **E2B infrastructure APIs:** provide microVM creation, snapshots, pause/connect, guest process/filesystem access, and traffic routing.
3. **Amp thread/executor communication:** connects a guest-resident Amp process to the managed thread so machine tools run in the correct working environment.

These are not one MCP interface. The exact Amp-internal RPCs and message schemas are not public evidence in this investigation. The API sketches below are explicitly reconstructions, not recovered endpoints.

## Evidence labels

- **Documented:** stated in current public Amp documentation or a primary-source article.
- **Observed:** read-only inspection of this particular orb. This does not prove fleet-wide configuration.
- **E2B source:** behavior established by E2B's public repositories, not necessarily every feature enabled in Amp's deployment.
- **Inferred:** a likely architecture consistent with those facts; alternatives remain possible.

No secret values, environment-file contents, credential-bearing arguments, private logs, or user data were printed. No infrastructure was restarted or modified. The installed Amp executable did not expose useful protocol strings in a bounded static search; no internal endpoint claims are based on it.

## 1. What is confirmed about the underlying technology?

| Finding | Evidence | Limit |
| --- | --- | --- |
| Amp uses E2B microVM orbs | Amp's [Handling Secrets / Tailscale section][amp-secrets] says “E2B microVM orbs expose only a link-local IPv4 interface” | Does not identify Amp's commercial contract, cloud account, or every provider it may use |
| This orb contains E2B's guest daemon | `/usr/bin/envd` embeds module path `github.com/e2b-dev/infra/packages/envd` | Does not pin the installed version to current public `main` |
| This is a Linux VM-style guest | Debian GNU/Linux 12; systemd PID 1; `systemd-detect-virt` returns `kvm` | KVM alone does not identify the virtual machine monitor |
| E2B uses Firecracker | [E2B infrastructure architecture][e2b-architecture] and orchestrator code identify Firecracker microVMs | Firecracker is strongly supported as the underlying E2B implementation; not directly observable as a host process from this guest |
| Amp executor runs in the guest | Guest-resident executor with local shell-tool descendants | Does not prove that the entire agent loop or inference orchestration lives in that process |
| Guest services have independent supervision | Read-only inspection confirmed supervised executor and terminal components; private unit/listener details are omitted | Does not establish fleet-wide configuration or every routing/authentication hop |

Amp's executable is an ELF x86-64 binary. That fact alone does not establish its implementation language or bundler. E2B's `envd` is a Go binary; its module metadata provides substantially stronger attribution than an executable name alone.

The E2B [“run Amp in a sandbox” integration guide][e2b-amp] is useful but is **not by itself evidence about Amp's managed Orbs backend**. Anyone can run Amp in an E2B sandbox. The direct Amp documentation statement and guest module identity are the decisive linkage here.

## 2. The likely whole-system topology

```diagram
┌──────────────────────────────────────────────────────────┐
│ Web / desktop / mobile / CLI clients                     │
│ Thread messages, progress, changes, terminal, previews    │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│ Amp backend                                              │
│ Thread coordination + retained data                      │
│ Orb lifecycle + identity + preview authorization         │
└─────────────┬──────────────────────────┬─────────────────┘
              │                          │
              │ E2B lifecycle API        │ Amp executor channel
              ▼                          │ (exact protocol unknown)
┌────────────────────────┐               │
│ E2B control plane      │               │
│ Placement / snapshots │               │
└─────────────┬──────────┘               │
              │                          │
┌─────────────▼──────────────────────────▼─────────────────┐
│ MicroVM guest                                            │
│                                                          │
│ Guest management API   Amp executor                      │
│ process/file API       └── shell tools / file operations  │
│                                                          │
│ systemd services     repo + dependencies + local state    │
│ Authenticated terminal bridge                            │
└──────────────────────────────────────────────────────────┘
```

The guest components are observed. E2B's lifecycle API is public. The Amp backend boxes describe responsibilities, not verified deployment units or database tables. The Amp executor channel must carry the information needed for remote work, but whether one socket, multiple channels, or another RPC mechanism handles each part is not established.

Do not draw the model itself inside the VM merely because a headless Amp process runs there. Public Amp material mentions separate server, inference, and thread-related components. The exact division of loop control, model calls, tool dispatch, context construction, and event persistence remains unresolved.

## 3. What E2B contributes, based on its public source

The current [E2B infrastructure architecture][e2b-architecture] describes a Go-based control plane, per-node orchestrators, Firecracker VMs, `envd`, and routing proxies. Its published deployment includes Postgres, Redis, object storage, Nomad/Consul, and telemetry systems. **These are E2B components, not evidence that Amp's own application uses those technologies.** Amp may consume hosted E2B or an account/deployment arrangement not visible here.

### VM creation is usually snapshot restoration

An E2B template is a pre-booted VM snapshot containing memory, root disk, and VM state. The usual create path restores a template instead of booting a fresh OS from scratch. Filesystem-only paths can cold-boot.

- Firecracker supplies VM isolation and snapshot primitives.
- Memory is demand-paged using `userfaultfd`.
- Rootfs uses copy-on-write storage exposed through an NBD block device.
- Per-sandbox network namespaces, veth/TAP plumbing, cgroups, and network policy isolate workloads.
- Snapshot artifacts include `memfile`, `rootfs.ext4`, `snapfile`, metadata, and header indexes.
- Paused snapshots can store dirty memory/rootfs differences relative to parent state.

This explains why warm project images and sleeping environments can be economical: a logical machine does not require permanently allocated guest CPU/RAM. It does not mean retained snapshot storage is intrinsically free; Amp's customer pricing is a separate product choice.

### E2B has separate lifecycle and guest APIs

From the public [OpenAPI specification][e2b-api]:

| Real E2B endpoint | Purpose |
| --- | --- |
| `POST /sandboxes` | Create from a template with resource/lifecycle/environment/network configuration |
| `POST /sandboxes/{sandboxID}/connect` | Return an existing running sandbox or resume a paused sandbox |
| `POST /sandboxes/{sandboxID}/pause` | Pause with the configured memory/filesystem preservation behavior |
| `POST /sandboxes/{sandboxID}/snapshots` | Capture a reusable snapshot |
| `POST /sandboxes/{sandboxID}/fork` | Create children from captured state |
| `DELETE /sandboxes/{sandboxID}` | Kill the sandbox |

The older `/resume` endpoint is deprecated in the inspected specification; use `connect` when describing the current public contract. These are **E2B endpoints**, not Amp's own API paths. Their existence does not establish that Amp calls every one of them.

Internally, E2B's API calls a per-node gRPC `SandboxService` with `Create`, `Update`, `List`, `Delete`, `Pause`, and `Checkpoint`. Restore shares the create path. The [orchestrator protobuf][e2b-orchestrator] records kernel and Firecracker versions and the filesystem-only distinctions.

### `envd` supplies the guest management API

`envd` listens on TCP 49983 and exposes protobuf-defined **Connect RPC over HTTP**, plus ordinary HTTP endpoints. It is not an MCP server.

The [process protocol][e2b-process] supports process listing, streamed start/connect, input, signals, and PTY operations. The [filesystem protocol][e2b-filesystem] supports filesystem metadata/mutation and watches; HTTP endpoints handle file transfer and other guest functions.

The [E2B JavaScript SDK][e2b-sdk] constructs Connect clients, uses JSON encoding for these calls, and supplies routing/authentication headers. Public guest calls use an envd access token; control-plane initialization and upgrade routes are not general public sandbox endpoints.

**Likely role in Amp:** envd helps prepare/bootstrap and manage the guest. Once the Amp executor runs, normal shell tools can spawn locally from Amp rather than requiring a fresh E2B SDK process call for every command. The observed process ancestry supports that normal-work path. Whether Amp uses envd for particular recovery, transfer, metrics, or administrative operations remains unverified.

### Routing and authorization exist below Amp portals

E2B's documented inbound path is:

```diagram
Sandbox hostname
      │
      ▼
Client proxy → node routing lookup → orchestrator proxy → guest port
```

The client proxy resolves sandbox identity to an owning node. The orchestrator proxy enforces sandbox traffic access controls and forwards to the guest. A traffic access token and an envd access token are different credentials with different jobs. E2B can auto-resume eligible sandboxes on traffic.

Amp adds a user-facing portal identity and access policy above provider routing. Do not expose an underlying provider URL and assume it is equivalent to an authenticated Amp portal. Nor should E2B's auto-resume feature be assumed to be the exact mechanism Amp uses for every portal wake.

## 4. New thread → prepared orb → connected executor

The following lifecycle is documented in [Customizing Orbs][amp-custom]:

1. **Select project and orb size.** A thread requests an orb for a project, or a no-project environment.
2. **Resolve prepared project state.** Amp checks for a matching project snapshot for that size and shared configuration/source state.
3. **Restore or prepare.** With a reusable snapshot, skip setup. Otherwise start from a base/older snapshot, run pre-clone, clone/update repositories, then pre-setup and `.agents/setup`.
4. **Publish reusable preparation.** If setup succeeds, save a refreshed project snapshot.
5. **Activate thread identity.** Apply current environment and runtime workload-identity credentials.
6. **Repair after activation.** Run `.agents/resume`, then start the agent/executor.
7. **Bind normal tools.** The thread's machine tools operate against the ready executor and its working directory.

There are important qualifications:

- Current docs allow a matching project snapshot to be reused for up to **72 hours**. The older July article describes **24 hours**. Use the current docs, not the historical number.
- Setup failure/timeout does **not** necessarily abort the orb: the docs say setup stops after 20 minutes and startup continues, without publishing a refreshed snapshot.
- The resume hook blocks for up to 10 seconds, then can continue in the background. Its completion is not a universal readiness guarantee for arbitrary dependencies.
- Setup-time subprocesses are stopped before snapshotting; supervised system services follow different rules.
- Reusable preparation and per-thread identity are intentionally separated.

Thus `provision → ready` is not a single sufficient status. A likely Amp management model distinguishes infrastructure availability, preparation outcome, executor connectivity, and service readiness, even if the UI combines them.

## 5. Threads, executors, and the unknown connection protocol

### What the evidence establishes

- A thread gets a machine executor for local shell/filesystem work; the model's `shell_command` schema contains no sandbox ID or provider credential.
- A guest-resident executor is supervised independently of user-facing clients. Private invocation settings are omitted and do not establish the approval policy for external actions.
- Amp supports local runners as well as orbs. Public CLI behavior does not establish the implementation of its managed executor.
- A public [Amp engineering article][amp-article] names `lib/thread-client`, `lib/thread-protocol`, a thread-actors service, WebSocket JWT configuration, and a separate inference service in development tooling.
- The current thread tool interfaces route shell work without making the model establish a transport session.

### Strong inference

Amp has a common logical executor interface shared across managed orbs and user runners, with some combination of registration/authentication, thread assignment, tool invocation, result delivery, and liveness information. An authenticated persistent WebSocket channel is plausible given the public WebSocket references and long-lived remote-control requirements.

### What is not proven

- That all thread/executor traffic uses WebSocket rather than several transports.
- Exact endpoint URLs, frame types, reconnect cursors, heartbeat intervals, or JWT claim shapes for this channel.
- Whether the executor initiates its main channel, the server opens it, or the system uses both. Connection presence alone does not identify its purpose.
- Whether every model turn is orchestrated server-side or guest-side.
- Cloudflare Durable Objects, actor-runtime deployment, or a particular database for Amp thread state. “Thread actors” is a component name, not proof of a vendor technology.

### A plausible contract, not Amp's recovered schema

```ts
type ExecutorHello = {
  executorId: string;
  threadId: string;
  generation: number;
  capabilities: string[];
  cwd: string;
};

type ExecuteTool = {
  invocationId: string;
  threadId: string;
  generation: number;
  name: string;
  input: unknown;
};

type ExecutorEvent =
  | { kind: "ready"; executorId: string; generation: number }
  | { kind: "tool_output"; invocationId: string; sequence: number;
      content: unknown }
  | { kind: "tool_result"; invocationId: string; result: unknown }
  | { kind: "health"; executorId: string; activeWork: number };
```

Authentication belongs to the authenticated channel/control plane, not a model-generated `threadId`. Generation fencing and replay cursors are recommendations for a design with restarts, not confirmed Amp guarantees. If loop orchestration runs in the guest, the channel may exchange user events and thread state rather than remotely dispatch each individual tool. Either arrangement can produce the same model-visible tools.

## 6. What the Amp orb service API probably looks like

The defensible reconstruction is a **thread-aware management API**, not a raw process API alone. The following names are proposed conceptual methods, not actual Amp SDK names:

```ts
interface OrbManager {
  ensureForThread(input: {
    threadId: string;
    projectId?: string;
    resourceClass: string;
    requestId: string;
  }): Promise<OrbBinding>;

  inspect(threadId: string): Promise<OrbStatus>;
  wake(threadId: string, reason: "prompt" | "portal" | "schedule" | "tool"):
    Promise<OrbBinding>;
  pause(threadId: string, reason: "idle" | "archive"):
    Promise<OrbStatus>;
  restartExecutor(threadId: string, options: { refreshEnvironment: boolean }):
    Promise<OrbBinding>;
  listProjectSnapshots(projectId: string): Promise<ProjectSnapshot[]>;
  invalidateProjectSnapshot(projectId: string, resourceClass?: string):
    Promise<void>;
}

type OrbBinding = {
  threadId: string;
  providerSandboxId: string; // Internal; not needed in ordinary agent tool calls.
  executorId: string;
  generation: number;
  workdir: string;
};

type OrbStatus = {
  machine: "provisioning" | "running" | "paused" | "unavailable";
  executor: "connecting" | "ready" | "disconnected";
  preparation: "pending" | "succeeded" | "degraded";
};

type ProjectSnapshot = {
  id: string;
  resourceClass: string;
  sourceFingerprint: string;
  createdAt: string;
};
```

Services, portals, terminal access, workload identity, and file transfer are adjacent APIs. The CLI's existing `amp orb service`, `portal`, `restart-processes`, and `id-token` commands prove corresponding capabilities exist, but not that they live in one backend service or share these method names.

An internal provider adapter would translate `ensureForThread` into E2B create/connect plus Amp-specific activation. A separate executor registry would translate a thread's tool execution target into the current ready guest process. This separates **machine existence** from **executor connectivity**, which is necessary to explain an orb whose files survive an Amp-process restart.

## 7. Pause/resume is not a single persistence promise

Keep four things separate:

| State | Source / behavior |
| --- | --- |
| Prepared project image | Shared starting state used to accelerate fresh threads |
| Existing orb snapshot | Retains an individual thread's modified machine state |
| Thread history / review records | Amp product data that must remain accessible independently of active compute |
| Live network connections and processes | Depend on provider preservation and Amp's own restart/update behavior |

E2B [documents memory-preserving pause][e2b-persistence], but also filesystem-only modes and a rolling fallback in a specific auto-pause backlog condition. Connections must be reestablished. These provider capabilities do not tell us which exact preservation settings Amp chooses on every wake.

Amp's own process refresh/update can restart its executor and descendants even if the provider restored memory. Amp's documented warning against unmanaged background services makes that operational distinction concrete.

Therefore, “the orb resumes” should not be translated into “every shell child and every socket always survives.” Amp gives services a separately supervised lifecycle and runs resume repair. No evidence here establishes continuous replication of arbitrary live filesystem writes before an abrupt provider failure.

Likewise, the public product's thread/history persistence is not proof of our earlier proposal's operation-ledger and exactly defined publication semantics. Those remain our design choices, not recovered Amp guarantees.

## 8. Terminal and portal connections

### Terminal

The terminal needs an authenticated route to a guest shell/session. Private listener and bridge configuration is omitted. The browser-side terminal implementation, precise authentication exchange, and whether every terminal uses the same transport remain unknown; a successful local session does not verify the external authorization path.

### Portals

Amp [documents portals][amp-portals] as authenticated URLs with access derived from the thread, separately from application login. Opening a portal can wake a sleeping orb. Services can be declared in `.amp/services.yaml`; `ensure` starts them and reports readiness and generated URLs. A URL may exist while the health check fails.

Likely full responsibility chain:

```diagram
Viewer → Amp portal authorization → orb wake/routing → guest service
```

The exact handoff from Amp proxying to E2B proxying is not recovered. Provider traffic credentials should remain internal to that routing path. Guest-local access to an Amp portal has a documented local route that bypasses external portal sign-in but not the application's own authentication; it is not a test of the external viewer path.

## 9. Identity is more nuanced than “no secrets in the sandbox”

Amp supports both configured secrets and temporary workload identity. Its [OIDC documentation][amp-secrets] specifies an RS256 issuer and public discovery/JWKS endpoints. Setup credentials can mint project/workspace identities; runtime activation supplies fresh credentials for thread-associated identity. The setup request credential is removed before a reusable project snapshot is saved.

The same documentation explicitly notes delayed workspace-membership revocation for the request-credential exchange path, potentially up to 24 hours. Do not describe that as immediate per-call revocation. Do not import our desired broker-only secret model into the description of Amp: configured environment secrets and workload identity are capabilities made available inside the orb.

Separate these identities in our own system: provider admin credentials, guest management/traffic credentials, Amp executor registration credentials, user-facing portal sessions, and workload credentials for the agent's application work. They should not be one reusable token.

## 10. What we should borrow for Action Space

1. **A stable logical context bound to ordinary tools.** The model should not select a sandbox ID on every file edit.
2. **A lifecycle manager separate from the guest executor.** Restarting the client should not destroy the machine or durable review record.
3. **Prepared templates separated from runtime identity.** Reuse dependency preparation without sharing personal credentials.
4. **Independent machine, executor, setup, and service readiness states.** A connected socket is not proof a development app works.
5. **Explicit supervised services and authenticated previews.** Do not attach service lifetime to one shell-tool process.
6. **Context continuity reports and durable operation identity.** Amp's product motivates these, but their precise contracts must be defined and tested in our implementation.
7. **An execution binding that can target managed microVMs or user runners.** Keep that independent from MCP tool discovery and API composition.

The research strengthens the case for using a provider such as E2B for the machine substrate while building our value in thread/task binding, action contracts, lifecycle, state guarantees, approvals, and review. It does not justify claiming that Amp has already implemented our proposed general execution scheduler or multi-runtime action system.

## Remaining questions that need Amp source or engineering confirmation

- Exact provider deployment and enabled persistence settings.
- Thread state schema, storage, and actor-runtime deployment.
- Executor registration/authentication and reconnect protocol.
- Server-side versus guest-side agent-loop responsibilities.
- Retry/deduplication guarantees for tool dispatch around disconnection.
- How pending shell processes and output streams are recovered after executor upgrade.
- Consistency and retention guarantees for machine snapshots and stored Changes captures.
- Exact portal/terminal authorization and provider-routing implementation.

No amount of guessing internal endpoint names resolves these. A useful next validation would be an engineering discussion or authorized source review organized around those concrete questions.

## Sources and reproducible observation methods

Amp: [Orbs][amp-orbs], [Customizing Orbs][amp-custom], [Handling Secrets][amp-secrets], [Portals][amp-portals], [Putting an Agent in an Orb][amp-article]. Current docs take precedence over historical articles where behavior differs.

E2B: [Architecture][e2b-architecture], [OpenAPI][e2b-api], [Orchestrator protobuf][e2b-orchestrator], [Process protobuf][e2b-process], [Filesystem protobuf][e2b-filesystem], [JavaScript SDK][e2b-sdk], [Persistence][e2b-persistence], [Amp integration][e2b-amp]. Repository links reference mutable `main`; they describe inspected public source, not a pinned Amp production build.

Read-only local inspection used `/etc/os-release`, `systemd-detect-virt`, process names and parent IDs, selected `systemctl show` fields, sanitized unit/command-line extraction, listener ports, `file`, and bounded static Go module metadata. Environment values and credential files were deliberately excluded. Local observations are a point-in-time view of this orb, not a provider-wide audit.

[amp-orbs]: https://ampcode.com/docs/orbs
[amp-custom]: https://ampcode.com/docs/orbs/customizing
[amp-secrets]: https://ampcode.com/docs/orbs/handling-secrets
[amp-portals]: https://ampcode.com/docs/orbs/portals
[amp-article]: https://ampcode.com/notes/putting-an-agent-in-an-orb
[e2b-architecture]: https://github.com/e2b-dev/infra/blob/main/docs/ARCHITECTURE.md
[e2b-api]: https://github.com/e2b-dev/infra/blob/main/spec/openapi.yml
[e2b-orchestrator]: https://github.com/e2b-dev/infra/blob/main/packages/orchestrator/orchestrator.proto
[e2b-process]: https://github.com/e2b-dev/infra/blob/main/packages/envd/spec/process/process.proto
[e2b-filesystem]: https://github.com/e2b-dev/infra/blob/main/packages/envd/spec/filesystem/filesystem.proto
[e2b-sdk]: https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/index.ts
[e2b-persistence]: https://docs.e2b.dev/sandbox/persistence
[e2b-amp]: https://docs.e2b.dev/agents/amp
