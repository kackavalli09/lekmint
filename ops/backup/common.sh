#!/usr/bin/env bash
# Source only. Credentials are read by PostgreSQL/rclone/age from protected files.
set +x
set -Eeuo pipefail
umask 077

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "Required tool missing: $1"; }
private_file() {
  [[ -f "$1" && ! -L "$1" ]] || die "Protected file missing or symlink";
  [[ "$(stat -c %u "$1")" == "$UID" ]] || die "Protected file must belong to current user";
  case "$(stat -c %a "$1")" in 600|400) ;; *) die "Protected file must have mode 0600 or 0400";; esac
}
pg_credentials() {
  : "${PGSERVICEFILE:?Set path to protected PostgreSQL service file}"
  : "${PGPASSFILE:?Set path to protected PostgreSQL password file}"
  private_file "$PGSERVICEFILE"
  private_file "$PGPASSFILE"
  # Do not allow connection secrets or overrides in environment/argv.
  for key in DATABASE_URL PGPASSWORD PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGOPTIONS; do
    [[ ! -v "$key" ]] || die "Unset $key; use protected service/password files instead";
  done
  export PGSERVICEFILE PGPASSFILE PGCONNECT_TIMEOUT=15
}
pg16() {
  "$1" --version | grep -Eq 'PostgreSQL\) 16\.' || die "PostgreSQL 16 client required";
}
query() {
  psql -X --no-password --dbname="service=$PGSERVICE" -v ON_ERROR_STOP=1 -Atc "$1" 2>/dev/null
}
database_version() {
  local version
  version=$(query 'SHOW server_version_num') || die "Cannot probe PostgreSQL";
  [[ "$version" =~ ^16[0-9]{4}$ ]] || die "PostgreSQL 16 server required";
}