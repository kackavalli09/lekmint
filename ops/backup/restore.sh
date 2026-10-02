#!/usr/bin/env bash
set +x
source "$(dirname "$0")/common.sh"
[[ $# == 0 ]] || die "Configure explicit non-secret restore inputs through environment"
for tool in pg_restore psql age jq sha256sum stat flock; do need "$tool"; done
pg16 pg_restore
pg_credentials
: "${PGSERVICE:?Set isolated restore PostgreSQL service name}"
: "${RESTORE_DATABASE:?Set expected fresh database name, beginning lek_recovery_}"
: "${RESTORE_DIR:?Set exact downloaded completed encrypted backup directory}"
: "${AGE_IDENTITY_FILE:?Set protected offline age identity path}"
: "${RESTORE_CONFIRM:?Set exact confirmation described in instructions}"
: "${EXPECTED_MANIFEST_SHA256:?Set manifest digest from independently trusted operator record}"
[[ "$PGSERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || die "Invalid restore service"
[[ "$RESTORE_DATABASE" =~ ^lek_recovery_[a-zA-Z0-9_]+$ ]] || die "Only lek_recovery_* databases allowed"
[[ "$RESTORE_CONFIRM" == "RESTORE ISOLATED $RESTORE_DATABASE NO PROMOTION" ]] || die "Explicit isolated restore confirmation missing"
private_file "$AGE_IDENTITY_FILE"
[[ ! -L "$RESTORE_DIR" && "$(stat -c %u "$RESTORE_DIR")" == "$UID" && "$(stat -c %a "$RESTORE_DIR")" == 700 ]] || die "Restore directory must be private, owned by current user, mode 0700"
export PGSERVICE
for file in database.dump.age manifest.json COMPLETE.json; do
  private_file "$RESTORE_DIR/$file"
done
exec 9>"$RESTORE_DIR/.restore.lock"
flock -n 9 || die "Restore already running"
jq -e '.format == 1 and .postgresMajor == 16 and .ciphertext == "database.dump.age"
  and (.ciphertextSha256 | test("^[a-f0-9]{64}$")) and (.appRevision | test("^[a-f0-9]{40}$"))
  and (.ciphertextBytes | type == "number")' "$RESTORE_DIR/manifest.json" >/dev/null || die "Invalid manifest"
hash=$(sha256sum "$RESTORE_DIR/manifest.json" | cut -d ' ' -f1)
[[ "$EXPECTED_MANIFEST_SHA256" =~ ^[a-f0-9]{64}$ && "$hash" == "$EXPECTED_MANIFEST_SHA256" ]] || die "Manifest does not match independently trusted digest"
jq -e --arg hash "$hash" '.format == 1 and .manifestSha256 == $hash' "$RESTORE_DIR/COMPLETE.json" >/dev/null || die "Incomplete backup or manifest checksum mismatch"
[[ "$(sha256sum "$RESTORE_DIR/database.dump.age" | cut -d ' ' -f1)" == "$(jq -r .ciphertextSha256 "$RESTORE_DIR/manifest.json")" ]] || die "Ciphertext checksum mismatch"
[[ "$(stat -c %s "$RESTORE_DIR/database.dump.age")" == "$(jq -r .ciphertextBytes "$RESTORE_DIR/manifest.json")" ]] || die "Ciphertext size mismatch"
database_version
actual=$(query 'SELECT current_database()') || die "Cannot identify restore target"
[[ "$actual" == "$RESTORE_DATABASE" ]] || die "Restore service points at wrong database"
objects=$(query "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'") || die "Cannot inspect target"
[[ "$objects" == 0 ]] || die "Target contains objects; only a fresh empty database allowed"
sessions=$(query 'SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()') || die "Cannot inspect target connections"
[[ "$sessions" == 0 ]] || die "Target has other connections; isolate it first"
# Fully authenticate ciphertext before touching the DB. No plaintext file is written.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$RESTORE_DIR/database.dump.age" >/dev/null 2>/dev/null || die "Age authentication/decryption failed"
if ! age --decrypt --identity "$AGE_IDENTITY_FILE" "$RESTORE_DIR/database.dump.age" 2>/dev/null |
  pg_restore --no-password --dbname="service=$PGSERVICE" --no-owner --no-acl \
    --single-transaction --exit-on-error 2>/dev/null; then
  die "Restore failed; keep target isolated and inspect securely before retry"
fi
printf 'Restore completed in isolated database. API remains unpromoted. Reconcile all financial state before activation.\n'