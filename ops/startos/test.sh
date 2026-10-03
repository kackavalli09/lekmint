#!/usr/bin/env bash
# Static and refusal checks only; does not start an API or database.
set -Eeuo pipefail
root=$(cd "$(dirname "$0")" && pwd)
sh -n "$root/api-entrypoint.sh"
sh -n "$root/postgres-entrypoint.sh"
sh -n "$root/postgres-healthcheck.sh"
bash -n "$root/package/build-local.sh"
node --check "$root/healthcheck.mjs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if PGDATA="$tmp" sh "$root/postgres-entrypoint.sh" >"$tmp/output" 2>&1; then
  echo "Missing PostgreSQL cluster must be refused" >&2; exit 1
fi
printf 15 > "$tmp/PG_VERSION"
if PGDATA="$tmp" sh "$root/postgres-entrypoint.sh" >"$tmp/output" 2>&1; then
  echo "Wrong PostgreSQL major must be refused" >&2; exit 1
fi
if MINT_OPERATION_MODE=invalid sh "$root/api-entrypoint.sh" >"$tmp/output" 2>&1; then
  echo "Invalid mode must be refused" >&2; exit 1
fi
printf 'StartOS source syntax and 3 refusal checks passed; containers/SDK not executed.\n'