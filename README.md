# Action Space

Run agent code and tools, keep the result, and recover it after a disconnect. Action Space is a typed work scheduler with two capabilities:

- **Code execution** (`code_execution` / `invocation`): bounded, stateless JavaScript with brokered `tools.*`, powered by Executor and QuickJS.
- **Sandbox** (`sandbox`): native Linux work. The `ephemeral` profile retains outputs; `persistent` retains a thread-bound workspace—not RAM or the whole machine.

Every invocation has a durable **Work** ID. The scheduler checks authority, resources, budgets and state affinity before ranking eligible providers. It does not run your agent loop or choose models.

## Start locally

Install Docker Engine/Desktop with Compose v2.20+, then run from this repository. No host Node installation or cloud credentials required.

```sh
docker compose up --build --wait
docker compose exec -T action-space node dist/scripts/container.js demo
```

Look for `Demo passed`: sums `11` and `5`, native artifact `forty-two`, retained workspace contents, and a mutation count of `1`. Repeating the demo retrieves the original mutation Work and checks the current files. Its first run needs an unbound demo thread.

The API listens on **http://127.0.0.1:3000**. For another port, copy [`.env.example`](.env.example) to `.env` and set `ACTION_SPACE_PORT=3001` (or `0` for an assigned port). Use a different `COMPOSE_PROJECT_NAME` for an independent stack.

Compose generates private credentials, starts PostgreSQL, runs schema initialization, then starts the API/scheduler. Named volumes hold credentials, the journal, artifacts and workspaces; PostgreSQL is not exposed to the host. `init` and `migrate` exiting with code 0 is normal.

**Local native execution is for trusted development only.** Commands share the coordinator's UID, mounted data/credentials and network. The setup mounts no Docker socket and uses no privileged containers, but it is not hostile-tenant isolation.

## Make an API call

These examples need `curl`, `jq`, and a POSIX shell. Load the generated token without displaying it; keep shell tracing off and never paste the token into logs or issues.

```sh
set +x
export ACTION_SPACE_TOKEN="$(docker compose exec -T action-space node dist/scripts/container.js token)"
export ACTION_SPACE_URL="http://$(docker compose port action-space 3000)"
curl --fail --silent --show-error "$ACTION_SPACE_URL/health"
```

Health returns `{"service":"Action Space","ready":true}`. Protected API routes return `401` without a bearer token.

Submit an async JavaScript body through `execute({code})`:

```sh
RESPONSE="$(curl --fail --silent --show-error "$ACTION_SPACE_URL/v1/execute" \
  -H "Authorization: Bearer $ACTION_SPACE_TOKEN" \
  -H 'Idempotency-Key: quickstart-sum-v1' \
  -H 'Content-Type: application/json' \
  -d '{"code":"return await tools.data.sum({values:[3,8]});"}')"
WORK_ID="$(printf '%s' "$RESPONSE" | jq -r '.work.id')"
printf '%s\n' "$RESPONSE" | jq '{work, catalog, phase: .status.phase}'
```

The response contains `{work, catalog, status}`. It may still be running. Read the **same Work** to get its result:

```sh
curl --fail --silent --show-error \
  "$ACTION_SPACE_URL/v1/work/$WORK_ID?waitMs=10000" \
  -H "Authorization: Bearer $ACTION_SPACE_TOKEN" \
  | jq '.state | {phase, outcome: .outcome.kind, result: .outcome.output.result}'
```

```json
{
  "phase": "settled",
  "outcome": "completed",
  "result": { "ok": true, "data": { "sum": 11 } }
}
```

If it is still pending, repeat the **GET**, not the program. The same submission key and body recover the same Work; a changed body conflicts. Unknown external effects require reconciliation, never blind replay. Completed results survive API restarts.

Inside a program, use `tools.search({query})`, `tools.describe.tool({path})`, and `tools[path](args)` or dotted calls. `return` supplies the result; `console.log` is bounded. There are no imports, ambient network/filesystem access, credentials or persistent JS heap. Nested tool calls are diagnostics within one Work, not independently scheduled child Work.

## Try remote MCP tools

In a **new terminal**, start a separate fixture stack. These are real local HTTP MCP servers, not company integrations; each has its own credentials and write counter.

```sh
export COMPOSE_PROJECT_NAME=action-space-mcp
export COMPOSE_PROFILES=mcp
export ACTION_SPACE_CONFIG_FILE=./config/mcp-local.json
export ACTION_SPACE_PORT=3001
docker compose up --build --wait
docker compose exec -T action-space node dist/scripts/container.js mcp-demo
set +x
export ACTION_SPACE_TOKEN="$(docker compose exec -T action-space node dist/scripts/container.js token)"
export ACTION_SPACE_URL="http://$(docker compose port action-space 3000)"
```

`mcp-demo` prints `PASS`: write result `11`, another tenant's value `83`, and one write even on repeat. It configures this thread's default connection as `red`. Read defaults with `GET /v1/thread/tools`; your trusted harness can update them with `PUT /v1/thread/tools`, body `{"connections":["red"],"expectedRevision":0}` on a fresh thread. Use the current revision from GET for later updates.

Select only `blue` for one invocation, replacing—not appending to—the thread defaults:

```sh
curl --fail --silent --show-error "$ACTION_SPACE_URL/v1/execute" \
  -H "Authorization: Bearer $ACTION_SPACE_TOKEN" \
  -H 'Idempotency-Key: quickstart-blue-v1' \
  -H 'Content-Type: application/json' \
  -d '{"connections":["blue"],"code":"return await tools.mcp.blue.read({});"}' \
  | jq '{work, status}'
```

Follow the returned Work ID as above; the completed result has `data.value: 83`. Omit `connections` and call `tools.mcp.red.read({})` to use the thread default again, or pass `[]` for no remote connections. Every selection is authorized and frozen before queuing; changing defaults cannot redirect admitted or retried Work.

For your own endpoints, configure separate registry, connection and credential references using [`config/mcp-local.json`](config/mcp-local.json) as the shape reference. Auth binds tenant/thread; configuration needs `mcp.configure` and `mcp.use:<id>` grants. **Streamable HTTP and explicit bearer credentials only**; OAuth/SSO and company registry sync are not implemented. Public HTTPS is the default; private addresses require reviewed CIDRs, and redirects are rejected. The fixture's broad private ranges are local-only. Business approvals belong to MCP servers/harnesses; elicitation is unsupported, never autoaccepted. See [integration and security details](providers/executor/INTEGRATION.md).

## Stop, restart, or reset

Run these in the terminal for the intended Compose project:

```sh
docker compose ps --all
docker compose logs --tail=100 -f action-space postgres
docker compose restart action-space
docker compose up --no-deps --wait action-space
docker compose down                         # preserves named volumes
docker compose up --wait                     # reuses Work, files and credentials
```

Before rebuilding an existing stack, stop the API with `docker compose stop action-space`, then use `docker compose up --build --wait`; the migrator cannot share the running coordinator's lock. Back up the journal, data and credentials together. Legacy pre-release journals fail closed rather than being reinterpreted—preserve them and use a separate project.

**Destructive reset:** `docker compose down --volumes` deletes this project's journal, workspaces, outputs and credentials (including fixture state). Ordinary `down` does not. Never use volume deletion to repair a migration error.

## Go further

- **Native work and retained workspaces:** [`examples/journeys.ts`](examples/journeys.ts) shows `sandbox.run`, `context.ensure`, thread binding, `sandbox.shell/read`, and sleep/wake. These are the requests run by `demo`.
- **MCP and Executor:** [integration note](providers/executor/INTEGRATION.md) covers configuration, supported backends, upstream pins, MIT attribution, patches and upgrades. Executor/MCP currently runs on QuickJS only. Cloudflare/E2B remain live-unqualified; Kubernetes was tested on local runc, not Kata.
- **Configuration:** [local](config/local.json), [QuickJS-only](config/quickjs.json), [optional providers](config/providers.example.json). Protected `GET /v1/schemas` and `/v1/capabilities` expose implemented contracts. Provider credentials stay outside images and tracked files.
- **Development:** `npm ci && npm run setup:executor && npm run check && npm test && npm run build`. Linux/Node 24/Python 3 are required for native tests. `npm run test:compose:mcp` runs disposable integration/restart tests and removes only its own project.
- **Design background:** [architecture proposal](ARCHITECTURE_ASTRA_XHIGH.md) and [runtime research](COMPOSE_STACK_RESEARCH.md). These include unimplemented proposals; executable schemas and the integration note are the current contract.
