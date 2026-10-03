# Consistent encrypted backups and manual financial recovery

Scripts are preparation sources for **Start9-local** execution, not Replit live
export tools. They are not installed, scheduled, connected to Google Drive, or
tested against real data. Never put plaintext dumps, identity keys, service
files, OAuth tokens, or mint secrets in Git/shared Replit workspace. No secrets
are passed as command arguments. Shell tracing is disabled; underlying tool
stderr is suppressed because database/remote diagnostics can contain secrets.
Scripts report the failed phase/explicit gate; investigate private diagnostics
locally with an operator rather than uploading credential-bearing error output.

## What is backed up (and what is not)

`pg_dump` 16 custom format captures one PostgreSQL consistent logical snapshot
of **all schemas, data, sequence values and constraints** in one DB, streamed
directly to `age` recipient encryption. `set -o pipefail` detects either failure.
Plaintext is never written to disk by these scripts (it exists in process
memory/pipes; OS swap/crash dumps/compromised host remain threats).
No selectively exported transaction tables, CSV reconstruction, or schema push.

Timestamped randomized private directories retain only ciphertext, non-secret
manifest/checksums and completion marker. The manifest records deployed git SHA,
PG major, dump interval, ciphertext size/hash, snapshot limitations and exclusions.
Dump interval is **not** an exact last committed transaction ID or database WAL
position. Later commits are excluded and may be financially critical.

`rclone copyto --immutable` uploads to a dedicated Google Drive remote directory.
The ciphertext and manifest are read back in full and SHA-256 compared before
uploading `COMPLETE.json`; its upload is also verified. This costs one complete
readback of ciphertext. Completion means uploaded bytes, **not** proven database
recoverability or final-state completeness. There is no remote deletion/sync,
retention cleanup, or age-based promotion. Failures preserve encrypted local
partials; a set without a valid matching completion marker is not selectable.
Monitor and budget growing local/Drive storage; review deletion manually only
after independently verified newer restores and legal/financial retention.

Logical dumps exclude PostgreSQL cluster roles/grants/tablespaces, external
signing wallets and their transaction history, offline secrets, and client
browser wallet proofs/blinding factors/localStorage. DB encrypted key ciphertexts
are included, but **SESSION_SECRET is not**. PostgreSQL restore permissions and
roles must be deliberately provisioned. A DB dump does not recover user wallets.
No WAL archive/PITR/replication is supplied: RPO is at least time since the last
successful dump snapshot and can be worse after failed backups. A five-minute
backup is still unsafe if even one accepted spend committed afterward.

Age encrypts to public recipients and authenticates ciphertext, but anyone with
the public recipient can create a new valid encrypted file. Unkeyed SHA-256 does
not establish provenance against a compromised Drive account. Keep manifest
digests in an independently trusted offline/operator record; restore requires
that trusted digest. Do not simply copy it from the same potentially compromised
Drive set and call it independent. Stronger signed manifests/WORM storage and
WAL/PITR remain optional future work, not implemented guarantees.

## Local configuration on Start9

Use the external `../startos/Dockerfile.backup` tools image in a properly mounted
one-shot StartOS action once SDK packaging is validated. Requirements: Bash,
PostgreSQL **16** clients/server, age, rclone, jq, GNU coreutils, util-linux/flock,
trusted HTTPS roots. Tool versions/base image digests require production pins.
Scripts must execute under the same UID that owns protected files. Data/config
directories must be private, non-symlink, mode 0700. Files checked by scripts must
be owned by current UID, mode 0600/0400, non-symlink; restore files also 0600/0400.
Never run with root host mounts or attach production DB to a recovery action.

Provision on Start9 only, outside the Git/source tree:

- PostgreSQL service file (`PGSERVICEFILE`) with named service, explicit local
  host/port/dbname/user and approved TLS requirements for remote DB access.
  Keep passwords out of the service file if possible; use `PGPASSFILE` with
  PostgreSQL's escaping format. The backup role needs complete dump access,
  but not permission to mutate application tables. Test permissions against
  synthetic state. Never put connection URIs/passwords on a CLI.
- Private `RCLONE_CONFIG`: operator runs rclone's **interactive** Google Drive
  remote authorization on their trusted workstation/device, transferring the
  protected config only to Start9's protected config volume. Restrict Drive
  account/access and verify refresh persistence. A Replit connector OAuth token
  is **not portable** and is not used. No Google secret is embedded here.
- `AGE_RECIPIENTS_FILE`: public age recipient file from the offline recovery
  identity. The private identity is kept offline, not routinely on Start9.
  Validate recipient/identity correspondence in a synthetic roundtrip first.
- `BACKUP_STATE_DIR`: durable, private ciphertext staging volume with free space
  exceeding a full dump plus retained history, not `/tmp` or repo/shared storage.

Export non-secret paths/settings in the action's protected configuration:

| Variable | Purpose |
| --- | --- |
| `PGSERVICEFILE`, `PGPASSFILE` | protected file paths |
| `PGSERVICE` | named service, simple letters/digits/underscore/hyphen |
| `AGE_RECIPIENTS_FILE` | public recipients path |
| `RCLONE_CONFIG` | protected local OAuth configuration path |
| `BACKUP_REMOTE` | dedicated remote prefix, e.g. `drive:lek-mint` |
| `BACKUP_STATE_DIR` | precreated owned 0700 durable directory |
| `APP_REVISION` | exact 40-character lowercase git SHA actually deployed |

Run `bash /opt/lek-backup/backup.sh` (container) or `bash ops/backup/backup.sh`
(controlled local checkout). No arguments. Unset `DATABASE_URL`, `PGPASSWORD`,
`PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGOPTIONS`: service
files are the only permitted connection source. Never paste secret values into
shell history or export secrets on an inline command. Path env values are fine.

Select a schedule only after the package/Drive/drill tests succeed; none is
installed here. StartOS action/timer semantics are pending SDK validation.
Set alerts for last successful **verified upload**, dump/upload/decryption/drill
failures, recipient mismatch/secret availability, DB/WAL/staging capacity and
Drive quota. Backup frequency affects potential lost state, not permission to
promote. Only one backup runs per private output directory (flock).

## Offline secret recovery

Before migration, separately escrow the **exact** `SESSION_SECRET` (no trimming
or new value), age private identity, external BTC wallet signing seed/keys and
required passphrases, admin credential/config recovery, Google account recovery,
DNS/Netlify/Replit ownership, and reviewed source/schema version. Use an offline
encrypted password vault or hardware/offline custody with separate access
controls and tested disaster access. Never store this bundle beside its
decryption key or as plaintext on Google Drive. Keep public key IDs/manifest
digests independently; do not print key material or upload it to this workspace.
DB backup without the original SESSION_SECRET cannot unlock historical keys.
Never rotate/revoke/reseed keys as a recovery shortcut.

## Isolated restore only

1. Fence all API writers, watchers/epoch engines and payout broadcasts; do not
   alter production during a restore drill. Independently provision a fresh DB
   named `lek_recovery_<incident>` on an isolated PostgreSQL 16 instance with a
   dedicated restore role. Network/auth isolation must prevent API connections.
   A name prefix and zero sessions are gates, **not proof of network isolation**.
2. Download exactly one reviewed completed directory (`database.dump.age`,
   `manifest.json`, `COMPLETE.json`) using protected local rclone configuration,
   e.g. `rclone --config /protected/rclone.conf copy drive:lek-mint/<chosen-id>
   /private/restore/<chosen-id>`. The script does not choose/download "latest".
   Set directories 0700, files 0600, correct owner, and keep ciphertext private.
3. Obtain the expected manifest hash from an independently trusted record,
   deployed source commit and exact original secrets. Independently review
   backup provenance, schema compatibility and approved incident plan.
4. Set `PGSERVICEFILE`, `PGPASSFILE`, `PGSERVICE` for isolated target only;
   `RESTORE_DATABASE=lek_recovery_<incident>`, `RESTORE_DIR`, protected offline
   `AGE_IDENTITY_FILE`, `EXPECTED_MANIFEST_SHA256` and exact confirmation:
   `RESTORE_CONFIRM="RESTORE ISOLATED lek_recovery_<incident> NO PROMOTION"`.
   This is a non-secret human interlock, not a substitute for authorization.
5. Invoke `bash /opt/lek-backup/restore.sh` or `bash ops/backup/restore.sh`.
   It validates marker/manifest/trusted digest/ciphertext size/hash, PG 16,
   target DB name, zero user objects/connections, and fully authenticates age
   ciphertext to `/dev/null` **before** any SQL restore. Then it streams age
   decrypt into `pg_restore --single-transaction --exit-on-error`, no `--clean`,
   no `--create`, no drop, no schema initialization, no key rotation or promotion.
6. Restore failure: remain isolated, inspect privately, rebuild a new empty DB
   deliberately if necessary. There is no automated cleanup/retry against a
   partly populated DB. Do not connect an active API for inspection.
7. Use pinned API source in **standby** only after state checks; verify keys
   decrypt, privileges/schema/constraints/sequences match and no boot mutations.
   Remove offline identity from online environment when finished.

## Manual Replit recovery — no automatic transaction failover

**A reachable backup, a fresh timestamp or a green `/readyz` does not prove
complete financial state. Missing spent proofs can enable double spending;
missing payout rows can lose obligations; missing issued signatures can strand
users. Default action on uncertainty is maintenance, not activation.**

1. Record incident and operator authorization. Switch static site to maintenance
   messaging, fence Start9 at network/credentials/process level, stop workers,
   drain in-flight requests, and stop payout broadcasts. DNS changes alone do
   not fence wallet clients or stale cached endpoints. If primary unreachable,
   prove it cannot return as a writer before continuing.
2. Keep Replit API explicitly standby with no workers; never publish an active
   instance connected to old/development DB just to recover availability.
   Restore on a separate incident PostgreSQL 16 DB, **not** the running Replit
   development/old production DB. Use the isolated procedure above.
3. Establish last accepted request and final committed state from the fenced
   primary's consistent final snapshot or verified DB/WAL transaction evidence
   covering every post-backup commit. Current scripts supply no WAL/PITR. If
   primary state is lost and completeness cannot be proven, **do not promote**.
   On-chain scans alone cannot reconstruct off-chain spent proofs/idempotency
   records. Reconcile unresolved events manually, with a financial expert,
   while remaining in maintenance.
4. Verify read-only financial invariants **against the source/final snapshot**:
   - Preserve **all** keysets (including inactive/revoked), IDs, encrypted
     material, epochs/rates/difficulty and exact original SESSION_SECRET.
     Decrypt historical mint keys and stored xpub without disclosing them.
   - Spent-proof ledger in `proofs`: no missing burns, same
     `(keyset_id, secret_hash)` uniqueness and spend states. On cloned test
     state, prove already-spent inputs remain rejected; never replay live
     spends just to test the database.
   - `signed_outputs` unique blinded-message `b`, original `c_blind`/DLEQ
     signatures and operation must survive; duplicate retries return the
     identical result rather than issuing again. Preserve mint requests'
     `issued_signatures`, `credited_txs`, `baseline_tip_height` and
     `excluded_txids`; deposit crediting must not mint twice.
   - Deposit address records/unique `(wallet_fingerprint, derivation_index)`,
     next derivation index, xpub configuration, transaction
     `(txid,address)` uniqueness, confirmation and issuance statuses must match.
     Compare chain history to pending/confirmed/issued requests and detect
     deposits paid after snapshot without inventing off-chain ledger entries.
   - Each melt proof burn still has its corresponding `payouts` obligation;
     pending/paid status, settlement time, frozen `paid_amount_sats` and
     `paid_amount_is_estimate` survive. Compare external broadcasts/operator
     payout records; never send a payout twice. Estimated legacy amounts
     require explicit review rather than treating them as precise settlement.
   - `swap_escrows` unique `proofs_hash`, amounts/converted value, claimedAt/
     `claim_bundle`, and `swap_escrow_outputs` blinded output uniqueness must
     match; replay semantics preserve identical claim signatures and no second
     appreciation payout. Include unclaimed escrow liabilities.
   - `token_supply_log`, `treasury_dust_log`, audit log, fee/admin config,
     metrics baseline and all operational configuration must match. Reconcile
     issued minus redeemed supply and liabilities including escrow with
     era/baseline rules in application `supply.ts`, not a naive lifetime sum.
     BTC ledger definition is era-scoped confirmed/issued net credits minus
     paid payouts; reconcile to actual external wallet assets/obligations,
     recognizing frozen quotes, legacy estimates and unprocessed deposits.
   - Schema/index/constraint definitions, sequences, row counts and protected
     row-level checksums/checkpoint evidence match final consistent source.
     Matching counts alone cannot establish state completeness.
5. Resolve every discrepancy before signoff; do not use seed, force-push,
   metrics rewrite, "ROTATE AND VOID", or key revocation to make numbers agree.
   Review change records and take a new encrypted recovery snapshot.
6. Authorized operator manually configures recovered DB/secrets on production
   Replit (not this workspace), sets active on **one** writer, checks DB-backed
   readiness and updates API routing/Netlify origins only after signoff.
   Preserve maintenance routing until application/external-wallet reachability,
   TLS, CORS, proxy boundary, credentials and watch/epoch behavior are verified.
   Monitor idempotent recovery reads, deposits, liabilities and double-spend
   rejection. Keep old primary permanently fenced while recovery is active.

## Failback to Start9

1. Never boot the old stale Start9 database active. Keep it fenced, standby.
2. Put Replit in maintenance, fence all traffic/workers/payout actions, drain
   accepted work and establish its final commit boundary. Take a new approved
   consistent encrypted final-state backup; don't reuse a pre-recovery dump.
3. Restore to a **fresh isolated** Start9 DB, original secrets and exact reviewed
   source version. Repeat all completeness/financial/invariant checks above,
   including Replit-era spends/issuance/payouts/escrows.
4. Record human authorization and only then make Start9 active, verify readiness
   and move frontend API routing. Replit stays standby/fenced, never shares a
   write-capable DB. Verify no stale endpoint can transact.
5. New verified encrypted backup + isolated restore drill, secret custody check,
   monitor and retain incident evidence. No automatic reverse sync or deletion.

Tests: `bash ops/backup/test.sh` provides 20 mocked checks, including failures,
corruption, confirmation, private-file gates and isolated restore. Mocks are
not actual encryption/cloud/DB integration. Complete those separate synthetic
integration tests and real financial cutover signoff before production use.