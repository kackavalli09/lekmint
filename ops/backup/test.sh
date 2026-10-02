#!/usr/bin/env bash
# Hermetic fixtures: no network, database, credentials, or genuine dump.
set -Eeuo pipefail
umask 077
root=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin" "$tmp/state" "$tmp/remote"
cat > "$tmp/bin/mock" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$(basename "$0")" in
  pg_dump)
    if [[ "${1:-}" == --version ]]; then echo 'pg_dump (PostgreSQL) 16.9'; exit; fi
    [[ "${FAIL_DUMP:-0}" != 1 ]] || exit 1
    printf 'NONPRODUCTION TEST FIXTURE'
    ;;
  psql)
    sql="${*: -1}"
    case "$sql" in
      *server_version_num*) echo 160009 ;;
      *pg_stat_activity*) echo "${MOCK_SESSIONS:-0}" ;;
      *current_database*) echo "${MOCK_DATABASE:-lek_recovery_test}" ;;
      *pg_class*) echo "${MOCK_OBJECTS:-0}" ;;
      *) exit 2 ;;
    esac
    ;;
  pg_restore)
    if [[ "${1:-}" == --version ]]; then echo 'pg_restore (PostgreSQL) 16.9'; exit; fi
    printf 'called' > "$TEST_TMP/restored"
    cat >/dev/null
    [[ "${FAIL_RESTORE:-0}" != 1 ]]
    ;;
  age)
    [[ "${FAIL_AGE:-0}" != 1 ]] || exit 1
    if [[ "$1" == --decrypt ]]; then
      tail -c +9 "${*: -1}"
    else
      while [[ $# -gt 0 ]]; do
        if [[ "$1" == -o ]]; then out="$2"; shift; fi
        shift
      done
      { printf 'TESTAGE:'; cat; } > "$out"
    fi
    ;;
  rclone)
    [[ "$1" == --config ]]; shift 2
    action="$1"; shift
    [[ "${FAIL_UPLOAD:-0}" != 1 ]] || exit 1
    if [[ "$action" == copyto ]]; then
      to="$TEST_TMP/remote/${2#drive:}"
      mkdir -p "$(dirname "$to")"
      cp "$1" "$to"
    elif [[ "$action" == cat ]]; then
      if [[ "${CORRUPT_REMOTE:-0}" == 1 && "$1" == *.age ]]; then printf corrupt
      else cat "$TEST_TMP/remote/${1#drive:}"; fi
    else exit 2; fi
    ;;
esac
MOCK
chmod 700 "$tmp/bin/mock"
for name in pg_dump psql pg_restore age rclone; do ln -s mock "$tmp/bin/$name"; done
export PATH="$tmp/bin:$PATH" TEST_TMP="$tmp"
unset DATABASE_URL PGPASSWORD PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGOPTIONS
export PGSERVICEFILE="$tmp/service" PGPASSFILE="$tmp/pgpass" RCLONE_CONFIG="$tmp/rclone"
export AGE_RECIPIENTS_FILE="$tmp/recipient" AGE_IDENTITY_FILE="$tmp/identity"
for file in service pgpass rclone recipient identity; do printf 'test-fixture-only' > "$tmp/$file"; done
export PGSERVICE=backup BACKUP_REMOTE=drive:lek-mint BACKUP_STATE_DIR="$tmp/state"
export APP_REVISION=0123456789012345678901234567890123456789
passed=0
pass() { passed=$((passed+1)); printf 'PASS: %s\n' "$1"; }
fails() { if "$@" >"$tmp/output" 2>&1; then echo "Expected failure" >&2; exit 1; fi; }
bash "$root/backup.sh" >"$tmp/output" 2>&1
pass 'backup happy path with mocks'
export RESTORE_DIR
RESTORE_DIR=$(find "$tmp/state" -name manifest.json -printf '%h\n' | head -1)
[[ -f "$RESTORE_DIR/COMPLETE.json" && "$(head -c8 "$RESTORE_DIR/database.dump.age")" == 'TESTAGE:' ]]
[[ "$(find "$tmp/state" -type f ! -name '*.age' ! -name '*.json' ! -name '.backup.lock' | wc -l)" == 0 ]]
pass 'only ciphertext and metadata persisted'
[[ "$(find "$tmp/remote" -name COMPLETE.json | wc -l)" == 1 ]]
pass 'remote complete marker'
FAIL_DUMP=1 fails bash "$root/backup.sh"
grep -q 'during encrypt' "$tmp/output"; pass 'dump failure propagated'
FAIL_AGE=1 fails bash "$root/backup.sh"
grep -q 'during encrypt' "$tmp/output"; pass 'encryption failure propagated'
FAIL_UPLOAD=1 fails bash "$root/backup.sh"
grep -q 'during upload-ciphertext' "$tmp/output"; pass 'upload failure propagated'
CORRUPT_REMOTE=1 fails bash "$root/backup.sh"
grep -q 'Remote ciphertext checksum mismatch' "$tmp/output"; pass 'remote byte corruption rejected'
[[ "$(find "$tmp/remote" -name COMPLETE.json | wc -l)" == 1 ]]
pass 'failed backup never receives complete marker'
chmod 644 "$tmp/pgpass"
fails bash "$root/backup.sh"
grep -q 'Protected file must have mode' "$tmp/output"; pass 'insecure credential permissions rejected'
chmod 600 "$tmp/pgpass"
APP_REVISION=bad fails bash "$root/backup.sh"
grep -q 'APP_REVISION must be a full git SHA' "$tmp/output"; pass 'unidentified deployed revision rejected'
export PGSERVICE=recovery RESTORE_DATABASE=lek_recovery_test
export RESTORE_CONFIRM='RESTORE ISOLATED lek_recovery_test NO PROMOTION'
export EXPECTED_MANIFEST_SHA256
EXPECTED_MANIFEST_SHA256=$(sha256sum "$RESTORE_DIR/manifest.json" | cut -d ' ' -f1)
RESTORE_CONFIRM=no fails bash "$root/restore.sh"
grep -q 'confirmation missing' "$tmp/output"; pass 'confirmation required'
MOCK_DATABASE=production fails bash "$root/restore.sh"
grep -q 'wrong database' "$tmp/output"; pass 'wrong database refused'
MOCK_OBJECTS=1 fails bash "$root/restore.sh"
grep -q 'contains objects' "$tmp/output"; pass 'nonempty target refused'
MOCK_SESSIONS=1 fails bash "$root/restore.sh"
grep -q 'other connections' "$tmp/output"; pass 'connected target refused'
FAIL_AGE=1 fails bash "$root/restore.sh"
[[ ! -e "$tmp/restored" ]]
grep -q 'Age authentication/decryption failed' "$tmp/output"; pass 'authentication failure never reaches restore'
EXPECTED_MANIFEST_SHA256=$(printf 'a%.0s' {1..64}) fails bash "$root/restore.sh"
grep -q 'independently trusted digest' "$tmp/output"; pass 'untrusted manifest refused'
cp "$RESTORE_DIR/database.dump.age" "$tmp/cipher-original"
printf corruption >> "$RESTORE_DIR/database.dump.age"
fails bash "$root/restore.sh"
grep -q 'Ciphertext checksum mismatch' "$tmp/output"; pass 'ciphertext corruption refused'
cp "$tmp/cipher-original" "$RESTORE_DIR/database.dump.age"
if ! bash "$root/restore.sh" >"$tmp/output" 2>&1; then cat "$tmp/output" >&2; exit 1; fi
[[ -e "$tmp/restored" ]]; pass 'isolated restore happy path with mocks'
FAIL_RESTORE=1 fails bash "$root/restore.sh"
grep -q 'Restore failed; keep target isolated' "$tmp/output"; pass 'pg_restore failure propagated'
mv "$RESTORE_DIR/COMPLETE.json" "$tmp/complete"
fails bash "$root/restore.sh"; pass 'incomplete backup refused'
printf '%s mock checks passed. No real DB, encryption, or cloud integration exercised.\n' "$passed"