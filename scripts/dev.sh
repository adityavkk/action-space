#!/usr/bin/env bash
set -euo pipefail
umask 077
directory="${ACTION_SPACE_DATA:-.data}"
mkdir -p "$directory"
if [[ ! -f "$directory/api-token" ]]; then
  openssl rand -hex 32 > "$directory/api-token"
fi
export ACTION_SPACE_TOKEN="$(cat "$directory/api-token")"
exec npm start
