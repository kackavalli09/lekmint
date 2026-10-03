#!/bin/sh
set +x
set -eu
# No passwords in command arguments, output or SDK properties.
# pgpass must belong to the probe user and be mode 0600.
export PGPASSFILE=/run/lek-config/pgpass
test -f "$PGPASSFILE"
test ! -L "$PGPASSFILE"
test "$(stat -c '%a' "$PGPASSFILE")" = 600
export PGCONNECT_TIMEOUT=3
exec psql -X -w -h 127.0.0.1 -p 5432 -U lek_probe -d lek \
  -v ON_ERROR_STOP=1 -Atqc 'SELECT 1' >/dev/null 2>&1