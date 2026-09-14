# Agent interface: typed actions, bound contexts, multiple adapters

Design proposal · September 10, 2026

> **Implementation status:** Historical proposal. [README](README.md) and [Executor integration](providers/executor/INTEGRATION.md) define the current API. Code execution records one Work with diagnostic MCP calls, not the nested child-Work or business-approval machinery proposed below. Service/preview and broader host APIs remain design material.

> **Current vocabulary:** This is a predecessor proposal; its examples remain historical design context, not the current launch schema. The [current API overview](ARCHITECTURE_ASTRA_XHIGH.md#api-at-a-glance) defines Code execution (`code_execution`/`invocation`, `code.execute`, `code-js-v1`) and Sandbox (`sandbox` with `ephemeral` or `persistent` lifecycle profiles, `sandbox.run`, `sandbox.shell`/`sandbox.read`). The agent API is `execute({code})` with in-program `tools.*`. Compose, Job, and Project are superseded public names; only declared workspace state is retained, not arbitrary root filesystem or RAM.

This develops the PR/FAQ after the discussion about scheduling and persistent contexts. Where the original PR/FAQ assumes every task begins with a workspace attachment, this proposal instead uses **work items, optional execution contexts, and durable resource references**. A workspace is one resource, not a prerequisite for all actions. Names and code below are proposed contracts, not implemented APIs.

## Recommendation

Build an ergonomic action SDK and a curated tool-descriptor package. Offer a hosted MCP server and native harness adapters over the same actions. Give agents direct, context-bound tools for frequent work and progressive discovery for the larger catalog. Offer bounded code mode for composition, not as the only way to interact.

The agent chooses the action, inputs, and required continuity. The scheduler chooses eligible placement. Policy—not the model or tool description—determines authority.

## What the prior art establishes

### Neon: generate contracts, curate workflows

[Neon's September 3 article](https://neon.com/blog/give-your-agent-neon-tools) describes this pipeline:

```diagram
OpenAPI → generated methods + schemas → ergonomic SDK → agent tools
                                                          │
                                               MCP / Mastra / Eve
```

The useful example is `branches.createAndConnect`: creating a branch, attaching compute, and fetching a connection string become one SDK workflow. Generated endpoint coverage is not sufficient; readiness, useful return values, and workflow boundaries need product decisions. The article reports 85 Management API tools plus 19 hand-written tools in the hosted server at publication.

Borrow selected SDK paths, shared validation, native adapters, and curated workflows. Do not copy the entire administrator SDK into the agent's default tool set. An execution equivalent is `services.ensurePreview`, which reconciles a service, waits within a bounded readiness window, and returns its actual readiness and authorized preview—not just a port-allocation response.

Neon explicitly says approval annotations are advisory to the host. Its hosted server separately adds authorization, scoping, filtering, ID injection, and sanitization. Our service must enforce grants and approvals server-side; annotations help a host present the right UI but cannot be the security boundary. [Neon's MCP documentation](https://neon.com/docs/ai/neon-mcp-server) also advises against production-database use. Borrow interface patterns without treating them as evidence of production safety.

### Amp: the environment is bound before ordinary work

There are two evidence levels here:

- **Public docs:** [Orbs](https://ampcode.com/docs/orbs) describes a machine per orb thread. [Portals](https://ampcode.com/docs/orbs/portals) documents CLI commands for supervised services, readiness, authenticated previews, and wake-on-access. [Agent to Agent](https://ampcode.com/docs/orbs/agent-to-agent) documents independent threads and explicit file exchange.
- **Observed in this Amp session:** the agent has `shell_command`, `shell_command_status`, file-editing and media tools, along with `create_thread`, messaging, and file-transfer tools. The shell tool accepts a command and working directory, not a provider or orb ID. Long-running shell calls return a handle for subsequent observation. Discovery and code composition are exposed through `tool_search` and `code_exec` for connected tools. This is an observation of this session's surface, not a claim about every Amp configuration or private implementation.

Amp therefore demonstrates a hybrid interface: ordinary tools operate in a bound execution context; an in-environment CLI handles some lifecycle workflows; separate tools handle collaboration. We have not established that Amp's internal orb interface is an MCP server, and the proposal does not depend on that being true.

Borrow the low-friction default context and supervised work handles. Improve portability by using durable operation IDs instead of exposing a PID as the cross-runtime identity. Keep spawning another *agent* in the managed-agent platform: an execution context does not inherently need its own conversation or model.

### Executor and MCP guidance: discovery and composition solve different problems

[Executor](https://executor.sh) exposes code-mode access to a discovered, schema-described tool catalog with host-side credentials. [MCP client best practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices) distinguishes progressive discovery from programmatic tool calling:

- Discovery avoids loading irrelevant definitions.
- Code mode avoids sending every intermediate result through the model.

They are complementary. Neither means a model should have to write a program to read one file or inspect one failed operation. Host support varies: returning a schema in tool text does not itself install a new native tool in every MCP client.

## Architecture and package boundary

```diagram
                  Typed ergonomic actions
                            │
                Curated tool descriptors
                            │
          ┌─────────────────┼─────────────────┐
          ▼                 ▼                 ▼
    Native tools       MCP adapter      Code bindings
          │                 │                 │
          └─────────────────┼─────────────────┘
                            ▼
           Authenticated action dispatcher
           Policy · approvals · operation ledger
                            │
                            ▼
           Scheduler → contexts and runtimes
```

- `@exec/sdk`: typed action methods and durable operation/context clients for trusted application code.
- `@exec/tools`: curated action descriptors, model-facing schemas, descriptions, examples, result presentation, and native adapters.
- Hosted MCP endpoint: authentication, server-side scope binding, selected catalogs, and protocol mapping.
- Optional `exec` CLI: the same action workflows for shell-oriented agents and humans. Not required to get a file-only or isolate-only agent started.

Keep a separate administrative surface for provider credentials, fleet management, tenant policy, billing configuration, and grant issuance. Code-mode stubs are a restricted view of the SDK, not the SDK loaded with administrator credentials.

## What the model sees at startup

The host supplies a compact, authoritative environment summary. For example:

```text
Execution scope: task-482
Default context: project (ctx_project_7)
  Linux workspace at /workspace; files checkpointed after successful publication.
  Services restart after wake; arbitrary process memory is not guaranteed.
  Current durable version: version-42. Local changes: none.
Other context: research (ctx_browser_2)
  Browser profile retained; open pages may need reopening after wake.
Available profiles: javascript-task, python-session, linux-project, browser.
Authority: project files writable; external publication requires approval.
```

This is information about granted scope, not a grant itself. Fetch it through `environment_inspect`; native hosts can inject it automatically. An MCP resource can expose the same data, but clients do not universally insert resource contents into model context.

The default context is a host-bound reference, not mutable global state in the server. Never have a shared `set_current_environment` that can redirect concurrent calls. Resolve and persist the target at admission. A missing target on a stateless action is fine; a missing target on a stateful action with no unambiguous binding is an error.

At resume, send a concise change report: files restored, durable version, services restarted, interpreter state lost or retained, browser reconnection required, and outstanding operation IDs. Do not make the agent infer continuity from whether its next command happens to work.

## Two distribution profiles, one action catalog

### Native or capable MCP host: direct tools plus discovery

Bind frequently used actions into a compact profile:

| Profile | Direct tools |
| --- | --- |
| Files | `file_read`, `file_edit`, `file_search` |
| Coding | File tools + `process_run`, `operation_get`, `service_preview` |
| Research | `browser_observe`, `browser_act`, artifact reading |
| Analysis | `python_run`, artifact reading, `operation_get` |

Always retain discovery and recovery access. The host can search and load additional native definitions if supported. Profiles are developer-configured defaults, not a fixed universal tool count; measure their token cost and model performance.

A direct `process_run` call might be:

```json
{
  "argv": ["pnpm", "test"],
  "cwd": "/workspace",
  "wait_ms": 1000
}
```

The adapter supplies the authenticated task scope, fixed context binding, and durable dispatch key. The scheduler resumes the bound project context as needed. The model does not supply tenant IDs, provider tokens, machine generations, or mandatory pricing knobs for every test run.

### Generic MCP host: fixed portable gateway

Offer a small gateway profile that does not require runtime tool-list mutation:

| Tool | Purpose |
| --- | --- |
| `environment_inspect` | Bound contexts, continuity, outstanding work, allowed profiles |
| `action_search` | Find authorized actions by task or keyword |
| `action_describe` | Exact versioned input/output schemas, examples, preconditions, effects |
| `action_call` | Invoke one described action with validated arguments |
| `operation_get` | Bounded wait, status, output pages, persistence, next steps |
| `operation_cancel` | Request cancellation; does not promise rollback |

Optionally expose `code_run` as a seventh tool. Context creation, forking, checkpoints, previews, and resource transfer are discoverable actions, not mandatory top-level tools. Known small catalogs can instead be exposed as ordinary MCP tools with no gateway indirection.

The generic `action_call` envelope cannot provide the same model-time argument constraints as a dedicated native schema. The server still validates against the selected action's exact version, and `action_describe` supplies the contract to the model. That is an explicit interoperability tradeoff, not equivalent static typing.

Example discovery and invocation, each a separate model tool call:

```json
{"query":"start a dev server and open a private preview"}
```

```json
{"action":"services.ensurePreview","version":"v1"}
```

```json
{
  "action":"services.ensurePreview",
  "version":"v1",
  "request_key":"task482-preview-web-1",
  "arguments":{
    "context":"project",
    "service":"web"
  },
  "wait_ms":1000
}
```

The `web` service must already be declared, or the descriptor's creation variant must receive its command and health configuration. A name alone does not let the service infer an arbitrary startup command. This action composes lifecycle steps without inferring application intent.

## Context actions express continuity rather than infrastructure

For ordinary work, use the bound context. For new stateful work, let the agent request a developer-approved profile:

```json
{
  "action":"contexts.ensure",
  "version":"v1",
  "request_key":"task482-analysis-context-1",
  "arguments":{
    "name":"analysis",
    "profile":"python-session",
    "continuity":"process-memory",
    "reason":"Reuse the loaded dataframe across analysis steps"
  }
}
```

`ensure` is scoped by task, logical name, and compatible specification. It returns the existing context or creates one; a conflicting specification errors rather than silently resetting state. The response returns a stable context ID and the resolved continuity and retention contract. Unsupported continuity fails before allocating incompatible resources.

An Orb-like profile would be `linux-project` with filesystem continuity, a workspace reference, supervised services, and a retention policy set by the developer. A one-off JS action requires no context at all. Browser actions require a specific session and observation; an existing device requires an explicitly authorized runner. These are correctness constraints for the scheduler.

Closing, releasing compute, deleting retained data, and forking are different actions. Do not combine them into an ambiguous `destroy` tool. Copying artifacts between contexts is explicit and authorized; a thread message or string containing a path does not transfer files.

## Code mode is a bounded composition surface

After discovery, the agent can submit a program with generated typed bindings:

```ts
// Source for code_run; illustrative bindings, not npm modules.
import { search, read } from "actions/files@v1";

const matches = await search({ context: "project", pattern: "**/*.ts" });
const findings = [];
for (const file of matches.items) {
  const content = await read({ context: "project", path: file.path });
  if (content.text.includes("TODO")) findings.push(file.path);
}
return { findings, moreFiles: matches.nextCursor !== null };
```

The host pins declarations, type-checks against them, and the server validates every nested call at runtime. Unschematized upstream output remains `unknown`. A type checker improves usability; it is not a sandbox or authorization mechanism.

The composition isolate has no ambient network, filesystem, or provider credentials. `python.run` or `process.run` bindings dispatch to separate workload runtimes. The composition interpreter is not the persistent Python interpreter or the project's Linux machine.

Nested calls have stable child operation identities, per-call enforcement, and bounded concurrency/output. Background submissions return operation references; do not hold a JS invocation open for a twenty-minute build. Durable operations outlive the script; its heap does not. Unawaited calls are not silently discarded: the parent result reports submitted children and their states.

For v1, encountering a nested action that requires approval suspends admission of further children and returns the pending action plus completed/in-flight child receipts to the harness. Already-dispatched work may finish. Approval resumes only the authorized action, not the entire program. The model can continue with a new program that references prior results. Do not promise arbitrary durable JavaScript continuations or replay side effects to reconstruct local variables.

## Results are part of the agent interface

Use method-specific typed outputs inside a consistent operation receipt:

```json
{
  "operation_id":"op_123",
  "state":"running",
  "context_id":"ctx_project_7",
  "output":{"stdout_preview":"Running 142 tests…","truncated":false},
  "cursor":"event-18",
  "persistence":{"state":"pending"},
  "next":{"tool":"operation_get","arguments":{"operation_id":"op_123","after":"event-18","wait_ms":1000}}
}
```

`wait_ms` controls how long the tool waits to report, not how long the process may execute. Runtime deadlines are separate. Completion returns exit status, relevant artifact references, output cursors, and persistence receipts. Program failure and dispatch failure are distinct.

For MCP, map validated results to `structuredContent` and provide a concise text representation for clients that need it. Return screenshot/image content blocks where supported rather than forcing the model to fetch or decode base64 JSON. Artifact references are private resource IDs, not automatically public URLs. Provide bounded artifact-reading tools for clients that do not expose MCP resources to the model.

An approval request is a normal pending operation state, not a generic error. The trusted application displays the exact action and supplies an authenticated approval through a separate control path. An ordinary agent cannot call `approve` on itself. Unsupported actions and execution failures become typed tool errors; preserve operation identity and possible-effect information when mapping to MCP `isError`. A broken transport says nothing definitive about execution.

### Retry identity must survive the adapter

Native adapters persist a dispatch key keyed by task and logical tool-call identity before sending work. Transport retry uses that same key. A new model tool call is not automatically the same business action.

For generic MCP clients lacking durable host integration, require a task-scoped `request_key` on mutating gateway calls and instruct the model to reuse it for that same attempted action. Dedicated native MCP tools need an equivalent key field when the host cannot supply one. Do not use the JSON-RPC request ID as a durable business-operation key. Reconnect/recovery starts with outstanding-operation discovery, not rerunning previous commands.

The server hashes normalized payloads, rejects key reuse with different inputs, and retrieves existing receipts for duplicate submissions. This prevents duplicate admission, not exactly-once external effects. Unknown external outcomes still require reconciliation.

An MCP connection or session ID is a transport/session mechanism, not the identity of a durable execution context. Reconnect authenticates again and rebinds to authorized context IDs and outstanding operations. Closing the transport does not release persistent compute state or cancel work implicitly.

## Host integration sketch

```ts
const tools = createExecTools({
  client: scopedExecClient,
  binding: { taskId, defaultContextId: projectContext.id },
  include: [
    "files.read", "files.edit", "files.search", "process.run",
    "services.ensurePreview", "contexts.ensure", "operations.get",
  ],
});

// Choose the adapter appropriate to the application:
registerMcpTools(mcpServer, tools);
// Or bind the descriptors directly into the managed-agent harness.
```

The bound context must be a prerequisite of the selected profile, not something every agent must create. An analysis or API-only agent can omit it. Native integration avoids unnecessary MCP transport inside a platform that already owns the execution service; hosted MCP makes the same actions available to external agents.

Tool selection is not authorization. The scoped client and server enforce access even if the model knows another action's name. API inputs can let an agent request a narrower limit or a new grant; they cannot override administrator policy, raise budgets, or self-approve data disclosure.

## What to implement and evaluate first

1. Curated descriptors for files, process execution, operation inspection, and an Orb-like context profile.
2. Native tool adapter plus hosted MCP with a small selected catalog; discovery gateway for broader catalogs.
3. Context summaries and explicit continuity reports on resume.
4. One ergonomic service-preview workflow and one persistent Python workflow.
5. Optional code mode after ordinary calls have stable result and recovery contracts.

Compare direct tools, gateway discovery, and code mode on the same tasks and models. Measure task completion, wrong-context actions, schema errors, duplicate submissions, context tokens, time to useful output, approval comprehension, and recovery after disconnection. Include stale browser observations, a lost process response, a checkpoint failure, and a paused project that restarts services.

The product principle is: **make the common action immediate, make the broader catalog discoverable, and make state continuity explicit.** Neither a giant `execute` tool nor thousands of raw endpoint tools should be the only interface.
