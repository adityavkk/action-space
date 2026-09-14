#!/usr/bin/env bash
# Opt-in live Docker test. Only this newly generated project's data is disposable.
set -euo pipefail
set +x
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPOSE_PROJECT_NAME="as-compose-test-$(date +%s)-$$"
export ACTION_SPACE_PORT=0
export ACTION_SPACE_CONFIG_FILE="$root/config/local.json"
unset OTEL_EXPORTER_OTLP_ENDPOINT COMPOSE_PROFILES
volume_count=3
if [[ "${ACTION_SPACE_TEST_MCP:-0}" == 1 ]]; then
  export ACTION_SPACE_CONFIG_FILE="$root/config/mcp-local.json"
  export COMPOSE_PROFILES=mcp
  volume_count=5
fi
project="$COMPOSE_PROJECT_NAME"
scratch="$(mktemp -d)"
dc() { docker compose --project-directory "$root" -f "$root/compose.yaml" -p "$project" "$@"; }
cleanup() {
  local result=$?
  trap - EXIT
  if ! dc down --volumes --remove-orphans --timeout 30; then
    echo "Cleanup failed; inspect test project $project. Existing projects were not targeted." >&2
    result=1
  fi
  if [[ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]; then
    echo "Test volumes remain for $project" >&2
    result=1
  fi
  docker image rm "$project-local:dev" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
  echo "Test project $project finished; exit=$result"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
sql() { dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -U action_space -d action_space -Atc "$1"; }
snapshot() {
  sql "SELECT jsonb_object_agg(request_key,jsonb_build_object('id',id,'lease',data->'lease','state',data->'state')) FROM work WHERE request_key ~ '^local-demo-v2/(code|ephemeral|ensure|edit|park|wake)$' OR request_key='mcp-demo-v1/write'"
}
token_digest() {
  dc exec -T action-space node -e "const fs=require('fs'),c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('/run/action-space-secrets/api-token')).digest('hex'))"
}
journey() {
  local address
  address="$(dc port action-space 3000)"
  [[ "$address" == 127.0.0.1:* ]]
  curl --fail --silent --max-time 5 "http://$address/health"
  echo
  [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "http://$address/v1/capabilities")" == 401 ]]
  dc exec -T action-space node dist/scripts/container.js demo
  if [[ "${ACTION_SPACE_TEST_MCP:-0}" == 1 ]]; then
    dc exec -T action-space node dist/scripts/container.js mcp-demo
  fi
  [[ "$(sql "SELECT count(*) FROM work WHERE request_key ~ '^local-demo-v2/(code|ephemeral|ensure|edit|park|wake)$'")" == 6 ]]
}
dc config --quiet
dc up --build --wait --wait-timeout 180
[[ "$(dc exec -T action-space id -u)" == 1000 ]]
dc exec -T action-space sh -c 'test ! -e /data/postgres'
sql 'SELECT version()'
[[ "$(sql "SELECT count(*) FROM pg_stat_activity WHERE usename='action_space' AND client_addr IS NOT NULL")" -ge 1 ]]
journey
snapshot > "$scratch/work-before"
token_digest > "$scratch/token-before"
old_container="$(dc ps -q action-space)"
dc restart action-space
dc up --no-deps --wait --wait-timeout 60 action-space
journey
snapshot > "$scratch/work-restart"
cmp "$scratch/work-before" "$scratch/work-restart"
dc up --no-deps --force-recreate --wait --wait-timeout 60 action-space
[[ "$(dc ps -q action-space)" != "$old_container" ]]
journey
snapshot > "$scratch/work-recreate"
cmp "$scratch/work-before" "$scratch/work-recreate"
dc down --timeout 30
[[ "$(docker volume ls -q --filter "label=com.docker.compose.project=$project" | wc -l | tr -d ' ')" == "$volume_count" ]]
dc up --wait --wait-timeout 180
journey
snapshot > "$scratch/work-after"
token_digest > "$scratch/token-after"
cmp "$scratch/work-before" "$scratch/work-after"
cmp "$scratch/token-before" "$scratch/token-after"
echo 'PASS: PostgreSQL wire connection; health/auth; QuickJS/tools; exact native artifact; fresh workspace reads; mutation count 1; unchanged Work/leases/outcomes after restart, recreation and down/up; stable credentials.'
if [[ "${ACTION_SPACE_TEST_MCP:-0}" == 1 ]]; then
  echo 'PASS: actual Executor + two remote MCP HTTP fixtures; tenant/credential isolation; replacement; remote write count 1; stable invocation and result after API/container/PostgreSQL/fixture recreation.'
fi
