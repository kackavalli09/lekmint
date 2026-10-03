#!/usr/bin/env bash
set +x
source "$(dirname "$0")/common.sh"
[[ $# == 0 ]] || die "Configure with non-secret environment variables, not command arguments"
for tool in pg_dump psql age rclone jq sha256sum stat mktemp flock; do need "$tool"; done
pg16 pg_dump
pg_credentials
: "${PGSERVICE:?Set backup PostgreSQL service name}"
: "${AGE_RECIPIENTS_FILE:?Set public age recipients file}"
: "${RCLONE_CONFIG:?Set protected local rclone configuration path}"
: "${BACKUP_REMOTE:?Set Google Drive remote and dedicated folder, e.g. drive:lek-mint}"
: "${BACKUP_STATE_DIR:?Set private durable backup output directory on Start9}"
: "${APP_REVISION:?Set exact deployed git commit}"
[[ "$PGSERVICE" =~ ^[a-zA-Z0-9_-]+$ ]] || die "Invalid PostgreSQL service name"
[[ "$APP_REVISION" =~ ^[a-f0-9]{40}$ ]] || die "APP_REVISION must be a full git SHA"
[[ "$BACKUP_REMOTE" =~ ^[a-zA-Z0-9_-]+:[a-zA-Z0-9_/-]+$ && "$BACKUP_REMOTE" != *..* ]] || die "Invalid dedicated backup remote path"
[[ -f "$AGE_RECIPIENTS_FILE" && -s "$AGE_RECIPIENTS_FILE" ]] || die "Public age recipients file required"
private_file "$RCLONE_CONFIG"
export PGSERVICE RCLONE_CONFIG
mkdir -p "$BACKUP_STATE_DIR"
[[ ! -L "$BACKUP_STATE_DIR" && "$(stat -c %u "$BACKUP_STATE_DIR")" == "$UID" && "$(stat -c %a "$BACKUP_STATE_DIR")" == 700 ]] || die "Backup directory must be owned by current user, mode 0700, not symlink"
exec 9>"$BACKUP_STATE_DIR/.backup.lock"
flock -n 9 || die "Another backup is running"
database_version
work=$(mktemp -d "$BACKUP_STATE_DIR/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXXXX")
phase=encrypt
trap 'printf "ERROR: backup failed during %s; encrypted partial artifacts kept locally; remote set is incomplete without COMPLETE.json\n" "$phase" >&2' ERR
started=$(date -u +%FT%TZ)
# The only persisted dump is ciphertext. pipefail detects failure on either side.
pg_dump --no-password --dbname="service=$PGSERVICE" --format=custom --no-owner --no-acl \
  2>/dev/null | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" -o "$work/database.dump.age" 2>/dev/null
finished=$(date -u +%FT%TZ)
hash=$(sha256sum "$work/database.dump.age" | cut -d ' ' -f1)
bytes=$(stat -c %s "$work/database.dump.age")
(( bytes > 0 )) || die "Empty ciphertext"
jq -n --arg started "$started" --arg finished "$finished" --arg revision "$APP_REVISION" \
  --arg hash "$hash" --argjson bytes "$bytes" \
  '{format:1,postgresMajor:16,appRevision:$revision,dumpStartedAt:$started,dumpFinishedAt:$finished,
    snapshotSemantics:"pg_dump consistent snapshot acquired within dump interval; later commits excluded",
    ciphertext:"database.dump.age",ciphertextSha256:$hash,ciphertextBytes:$bytes,
    excludes:["SESSION_SECRET","age private identity","external wallet signing keys","PostgreSQL roles","frontend browser wallets"],
    promotion:"manual only; completeness cannot be inferred from backup age"}' > "$work/manifest.json"
manifest_hash=$(sha256sum "$work/manifest.json" | cut -d ' ' -f1)
remote="${BACKUP_REMOTE%/}/$(basename "$work")"
phase=upload-ciphertext
rclone --config "$RCLONE_CONFIG" copyto "$work/database.dump.age" "$remote/database.dump.age" --immutable 2>/dev/null
phase=verify-remote-ciphertext
remote_hash=$(rclone --config "$RCLONE_CONFIG" cat "$remote/database.dump.age" 2>/dev/null | sha256sum | cut -d ' ' -f1)
[[ "$remote_hash" == "$hash" ]] || die "Remote ciphertext checksum mismatch"
phase=upload-manifest
rclone --config "$RCLONE_CONFIG" copyto "$work/manifest.json" "$remote/manifest.json" --immutable 2>/dev/null
remote_manifest_hash=$(rclone --config "$RCLONE_CONFIG" cat "$remote/manifest.json" 2>/dev/null | sha256sum | cut -d ' ' -f1)
[[ "$remote_manifest_hash" == "$manifest_hash" ]] || die "Remote manifest checksum mismatch"
jq -n --arg hash "$manifest_hash" --arg verified "$(date -u +%FT%TZ)" \
  '{format:1,manifestSha256:$hash,remoteVerifiedAt:$verified}' > "$work/COMPLETE.json"
phase=upload-completion-marker
rclone --config "$RCLONE_CONFIG" copyto "$work/COMPLETE.json" "$remote/COMPLETE.json" --immutable 2>/dev/null
phase=verify-completion-marker
remote_marker_hash=$(rclone --config "$RCLONE_CONFIG" cat "$remote/COMPLETE.json" 2>/dev/null | sha256sum | cut -d ' ' -f1)
[[ "$remote_marker_hash" == "$(sha256sum "$work/COMPLETE.json" | cut -d ' ' -f1)" ]] || die "Remote completion marker mismatch"
trap - ERR
printf 'Encrypted backup uploaded and byte-verified. No promotion or retention deletion performed.\n'