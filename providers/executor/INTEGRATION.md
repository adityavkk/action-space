# Executor integration decision

Action Space runs the actual Executor SDK, execution engine and patched QuickJS runtime in a **fresh disposable process per code Work**. It does not run Executor's HTTP service, share its mutable connection catalog between tenants, host customer packages, or create a second authoritative run store. The upstream SDK's private in-memory catalog is discarded with the process. PostgreSQL Work remains the admission, placement, observation and result identity.

## Exact upstream code and provenance

Reference source inspected: [UsefulSoftwareCo/executor at cc0fd8f](https://github.com/UsefulSoftwareCo/executor/tree/cc0fd8f6099f3d05c73a285ef14932c01ac212fa). Runtime sources embedded in the published source map match this reference. The published SDK/execution packages are **not byte-identical to that Git revision**: SDK has 77 matching and 5 differing source-map files; execution has 6 matching and 1 differing file. Reviewed differences concern schema cache invalidation, schema-preview bounds/reference filtering, OAuth refresh, a regression test and skill prose. This integration never enables OAuth and discards its catalog per invocation; broker-side schema bounds apply independently. Do not describe the entire npm release as a build of the reference commit.

The executable pin is the npm release plus integrity in `package-lock.json`:

| Package                        | Version | npm integrity                                                                                     |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `@executor-js/sdk`             | `1.6.8` | `sha512-6+983efkgy6w+iqNedkVJMLG078thQzMRoN0wbIgzAelXHp0qWxSQKo2Ehl0ZCnfo6mXVYLCF1VmaF1wvgG4KQ==` |
| `@executor-js/execution`       | `1.6.8` | `sha512-RWCUqxYS3u4l0IrwahaBnY5DvFnW5YC98HwopUgpit36UZBGU59eJfToC3uy1IN5PdpBIny1Zh/46/2hxev/0A==` |
| `@executor-js/runtime-quickjs` | `1.6.8` | `sha512-iwTdNQbVRyTkH7OhbrkpMpSXPYtYJXBrfiy0a1nFUwgkcclm0kyn3OZiVQ0s2zO17sajliifLsuOzYBK45F2JQ==` |

`runtime.js` is the actual published `@executor-js/runtime-quickjs/dist/index.js` bundle with the narrowly scoped changes below, not a reimplementation of its proxy. Original bundle SHA-256: `80a2ef006310117041e4c5c18abb7b2aebbef4aa1eba7f69326893e9e10fa185`. Its source-map `index.ts` SHA-256: `a85afb5d5ac00ef9e613f84081ceb903c5485f26c8f504c2a51a70a27d3f986f`. The adjacent MIT `LICENSE` retains upstream's copyright/permission notice (Rhys Sullivan, 2026); preserve it when distributing the bundle. Dependencies retain their own package licenses.

The isolated dependency tree pins Effect `4.0.0-beta.59`, while Action Space uses `4.0.0-beta.107`; no incompatible Effect objects cross IPC. QuickJS is overridden to the researched `quickjs-emscripten@0.32.0` in both trees. Node 24 is only a trusted wrapper, not the guest engine. This identifies reproducible code, **not a security-approved engine/production isolation boundary**.

## Small runtime patch, explicit host ownership

Changes to the vendored runtime:

1. Wall deadline is fixed, including waits for broker calls. Upstream suspended/reset its deadline around tool dispatch.
2. Microtasks are pumped in batches of 32 with deadline checks; a host cumulative CPU interrupt callback is also installed.
3. Console lines stream through a bounded host hook before accumulation. The first excessive line interrupts execution.
4. Execute the validated async JavaScript body exactly: no TypeScript stripping or source-body recovery. No `emit` surface; `fetch` is absent rather than an exposed throwing stub.
5. Remove the now-inaccurate published source-map trailer and add attribution.

`runner.js` owns IPC, per-invocation SDK construction, descriptors mapped to `definePlugin().staticIntegrations`, and `createExecutionEngine().execute`. It strictly JSON-encodes the guest result before QuickJS's lossy object dump. There are no credentials in its environment. Only the supplied tool handlers can cross the broker boundary. SDK `coreTools`, dynamic MCP/OpenAPI plugins, provider setup, OAuth and URL-probing tools are **not enabled**. The engine's existing read-only search, description and integration-list metadata remain available. A throwing elicitation callback is defense in depth, not permission to enable management tools.

`src/backends/quickjs.ts` owns the independent process watchdog, 256 MiB wrapper V8 heap ceiling, IPC limits and teardown. A dedicated inherited pipe carries validated frames; upstream stdout/stderr diagnostics are discarded rather than mixed into IPC or exported with possible arguments. Guest console uses the separately bounded frame hook. The guest has configured allocator/stack limits; CPU accounting is cumulative wrapper CPU after catalog setup, not exact guest billing. SDK/schema setup is covered by wall and wrapper limits. A process/WASM boundary alone is not hostile-tenant containment: qualify OS isolation, cgroups, egress and current engine patches before production.

`src/mcp.ts` stays in the trusted control plane. It uses the official MCP SDK over reviewed Streamable HTTP endpoints, with versioned credential references, per-request connection authority, bounded transport and Ajv validation. No raw remote URL/token enters guest source. No upstream `autoApprove` or accept-all policy is enabled. Elicitation is explicitly unsupported; the MCP server receives an error, source stops and Work records uncertainty. Other unadvertised server interactions are unsupported by the SDK, not automatically accepted.

## Public API and durable identity

- `GET /v1/thread/tools` reads `{revision,connections}` for the authenticated tenant/thread.
- `PUT /v1/thread/tools` takes `{connections:["company_tools"],expectedRevision:0}`. The trusted principal needs `mcp.configure` and `mcp.use:<id>` for every reference.
- `POST /v1/execute` takes `{code,connections?}`, plus the usual bearer token and stable `Idempotency-Key`. Omitted selection uses thread defaults; an explicit array replaces defaults, including `[]`. Separately granted built-in tools are unaffected.
- Before queuing, freeze registry/connection revisions, endpoint policy, catalog schemas, credential identity/revision/fingerprint and defaults revision into Work. Resolve retries before discovery. Changed defaults/registry entries do not retarget admitted source; changed bytes under a frozen credential revision fail closed. The server behind a stable URL is not snapshotted.
- Return `{work,catalog,status}`. `GET /v1/work/:id` observes the same invocation/result after reconnect or coordinator restart. `execute({code})`, `tools.search`, `tools.describe.tool`, `tools[path](args)`, dotted calls, `return` and bounded `console.log` remain the guest interface.
- Remote tool names are `mcp.<connection-id>.<tool-name>`. Ordinary results are `{ok,data}` or `{ok:false,error:{code,message,details?}}`. MCP structured content becomes `data`; otherwise `data.content` preserves content blocks. Absent output schemas remain `unknown`.

**One code invocation is one Work.** Nested tool calls are bounded concurrent calls with diagnostic started/observed events, not child Work, scheduler admissions or an Action Space business-approval machine. Business approval belongs to the server/harness. Known MCP failures are values; lost/invalid responses after dispatch and unsupported interaction become uncertainty, close source continuation and never cause automatic replay. Runtime loss cannot provide per-tool exactly-once or durable JavaScript continuation. A completed write remains externally completed if later source fails.

Connection/registry/credential entries are separate trusted configuration in `config/mcp-local.json`. Credentials are explicit bearer secret references loaded from configured environment keys; user/service-account identity is operator-selected, never guessed. OAuth/SSO, refresh and live company registry synchronization need real integration. Public HTTPS is the default endpoint policy; private endpoints require explicit reviewed CIDRs. URL credentials/query/fragment and redirects are rejected, DNS is checked before requests and at socket lookup, and responses/catalogs are bounded. The current JSON Schema subset rejects recursive references and regex, caps depth/node count, and does not validate format annotations.

Existing journals are not deleted. The idempotent local schema adds `thread_tools`; old completed Work remains readable. Old queued code without a frozen scope fails `LEGACY_CODE_SCOPE`. Historical child/approval records remain evidence, but new code mode creates neither. The earlier offering-format migration guard is unchanged.

## Backend support and verification

| Backend                    | Code execution                                                                                            | Sandbox                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| QuickJS                    | Actual Executor, `code-js-v1` and `code-mcp-js-v1`, locally executed                                      | —                                                                                          |
| Cloudflare Dynamic Workers | Existing binding-based gateway, built-in tools only, `code-js-v1`; remote descriptors explicitly rejected | —                                                                                          |
| Kubernetes Agent Sandbox   | —                                                                                                         | Ephemeral and persistent; previous live local controller test on runc, not production/Kata |
| E2B                        | —                                                                                                         | Ephemeral and persistent; official SDK/client doubles, not live provider                   |
| Local development native   | —                                                                                                         | Real shell/Python and retained workspace; trusted commands only                            |

The scheduler still filters authority, deadline/budget, capacity, capability/lifecycle, profile, locality/trust and sticky Context affinity before ranking configured cost/startup/transfer/reuse estimates. Remote selections require `code-mcp-js-v1`; Cloudflare cannot win that placement merely by being cheaper. Cloudflare does not currently run this upstream Executor stack. Porting it requires packaging its Worker runtime and validating deployed `LOADER` bindings; no generic REST isolate API is invented.

Run `npm run setup:executor`, `npm run check`, `npm run build`, `npm test`, and `npm run test:compose:mcp`. Tests use the actual selected packages and disposable real HTTP MCP servers, not a fake Executor. They cover asymmetric catalogs/credentials, replacement/defaults, frozen admission, denied refs, duplicate effects, restart retrieval, known/uncertain results, interaction rejection and endpoint/response bounds. The Compose harness also checks native results and PostgreSQL/workspace/credential persistence through restart/recreation/down-up, then removes only its test project. These are local fixture tests, not corporate registry or live Cloudflare/E2B qualification.

## Upgrade procedure

1. Inspect the selected upstream source and npm package contents/licenses; do not infer a Git pin from a matching version string. Update the three exact versions and lockfile together using `npm install --prefix providers/executor --ignore-scripts` with explicit versions. Review transitive changes, Effect compatibility and engine provenance.
2. Compare the new published runtime against `runtime.js` and reapply only the documented patches. Preserve MIT attribution. Record original bundle/source-map hashes and actual source differences; do not format the vendored bundle (`.prettierignore` protects it).
3. Inspect SDK defaults, management-tool exposure, elicitation, retry behavior, schema handling and data stores. Keep only private static integrations. Do not add mutable global service configuration or enable auto-approval.
4. Run the checks above, including CPU/wall/async/output/clean-state regressions, forbidden management tools, effect uncertainty and real Docker persistence. Update this note and the capability matrix only for verified behavior. Live cloud/company deployment is a separate approval and qualification step.
