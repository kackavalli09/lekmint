#!/bin/sh
set +x
set -eu
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "PGDATA missing: deliberate fresh cluster initialization OR isolated restore setup required; refusing automatic initialization" >&2
  exit 1
fi
if [ "$(cat "$PGDATA/PG_VERSION")" != 16 ]; then
  echo "Only PostgreSQL 16 data directories supported" >&2
  exit 1
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"