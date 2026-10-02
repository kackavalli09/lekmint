# Hosting migration preparation — not a completed cutover

## Selected architecture

Start9 hosts the active mint API and PostgreSQL. Netlify hosts the existing wallet
and admin on the same public origin, forwarding `/api` to the current active
host. Google Drive holds encrypted backup files. Replit can be manually activated
only after restoring verified complete financial history and disabling the old
writer. Outages pause online transactions, not trigger automatic promotion.

## Implementation and operator guides

- [Netlify build and routing](netlify/README.md)
- [StartOS runtime sources and unresolved SDK/package gates](startos/README.md)
- [Encrypted backups, isolated restore, manual recovery and failback](backup/README.md)
- [External outage email monitor](monitor/README.md)

The connected Drive account has a new destination folder:
https://drive.google.com/drive/folders/1ZhCbijWUiTdtig4Ky2vt5kBg5cSYGrTZ
No ledger or secret files have been uploaded. Configure Start9-local rclone
authorization separately; Replit's connector is not a portable OAuth credential.

## Runtime controls

`MINT_OPERATION_MODE` accepts `active`, `standby`, or `maintenance`; invalid values
abort startup. Existing configurations with no setting retain active behavior,
so **explicitly set standby before connecting any recovered database**.

Passive modes skip startup repairs, genesis, key access, email and background jobs.
Every ledger route, including GET handlers, returns 503. `/api/healthz` is
liveness; `/api/readyz` returns 503 in passive mode without querying the database.
Active readiness checks database reachability and successful initialization;
it does **not** certify backup completeness or authorize promotion.

Set `MINT_RELEASE_ID` to an immutable reviewed commit identifier. `TRUST_PROXY`
must match the real trusted gateway boundary. Do not expose an upstream directly
while trusting client-supplied forwarding headers.

Shutdown drains HTTP requests and background jobs with a 30-second deadline.
A forced exit is not evidence of a clean financial checkpoint. Prove the old
process is stopped and capture complete authoritative state before promotion.
No dashboard button or public HTTP endpoint can activate a restored mint.

## Verification so far

Workspace typechecks, API build, isolated operational-mode checks, 14 mocked
monitor tests, 20 mocked backup/restore checks, StartOS source/refusal checks,
and 4 Netlify routing tests pass. The outage banner renders with the API down.
These do not substitute for real encryption/upload/restore or hardware tests.

## Activation blockers

- Development API already fails stored-key decryption with the current
  `SESSION_SECRET`. Restore the original matching secret through protected
  settings; never generate a replacement, delete keysets, or bypass the check.
- Confirm Start9 CPU architecture and exact SDK/CLI compatibility with 0.4.0.1.
  Runtime sources are supplied; there is **no installable or tested `.s9pk` yet**.
- Confirm the existing production wallet origin, public API origin, DNS control,
  Netlify access and actual production database. Do not infer them from dev URLs.
- Configure separate off-site email secrets, monitor state issue and opt-in
  activation. Alerts to `info@lekmint.cash` are not live until exercised.
- Supply a public age recipient and configure local protected backup credentials;
  perform a real isolated backup/restore rehearsal. Preserve decryption material
  separately, and never resume from a snapshot with unverified missing commits.
- Review and synchronize source through the private GitHub repository; review
  releases before installation. GitHub source is not a database backup.
- Production publishing, DNS cutover, and paid services require explicit approval.

The existing post-merge script pushes development schema. Do not run it as a
production deployment hook; production migration needs reviewed migrations and
recoverable backups.