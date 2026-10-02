# Lek Mint — StartOS 0.4.0.1 preparation

**Source only, NOT an installable StartOS package.** No `.s9pk`, StartOS install,
Docker build, durable-volume test, live migration, or Google Drive authorization
has been performed. No schema, live database, or secret was read/exported.

Chosen architecture: Start9 primary API + PostgreSQL 16, Netlify static wallet
and admin, encrypted Google Drive backups, manually activated Replit recovery.
There is never automatic transaction failover. GitHub contains source, not state.
The operator reports an Embassy Pro, StartOS 0.4.0.1, 32 GB RAM and approximately
1 TB free. Start9's official hardware reference identifies the Embassy Pro
(later Server Pro / Server Pure 2023) as an Intel Core i7-10510U, x86_64 machine:
https://docs.start9.com/start-os/0.4.0.x/start9-hardware.html
Target external builds at linux/amd64. This identifies the model's architecture;
it does not verify this unit's installed OS, SDK compatibility, storage durability,
network reachability, or available headroom.

## Official packaging research and compatibility gate

Read the official 0.4.0.x guide before preparing these sources:

- https://docs.start9.com/packaging/0.4.0.x/quick-start.html
- https://docs.start9.com/packaging/0.4.0.x/environment-setup.html
- https://docs.start9.com/packaging/0.4.0.x/project-structure.html
- https://docs.start9.com/packaging/0.4.0.x/manifest.html
- https://docs.start9.com/packaging/0.4.0.x/main.html
- https://docs.start9.com/packaging/0.4.0.x/makefile.html

The documented 0.4 API is TypeScript `setupManifest`, package-specific
`StartSdk`, `setupMain`, `Daemons`, `SubContainer`, `Mounts`, interfaces,
initialization, actions, versions, and backup exports. It is **not** the older
0.3 `manifest.yaml`/Docker Compose format. `sdk.useEntrypoint()` preserves image
entrypoints. Daemon `requires` expresses startup dependencies. Official examples
describe `exec.runAsInit` for supervisors; volumes must be mounted explicitly.
The current guide discusses SDK 2.0 but also shows older beta versions: the
moving documentation is **not proof that a particular SDK works on 0.4.0.1**.
No exact SDK/CLI lock compatible with the user's exact OS has been verified.
Accordingly this directory intentionally supplies no fabricated SDK manifest,
unvalidated package exports, image registry URL, or alleged `.s9pk` build.

Official architecture names are `x86_64`, `aarch64`, `riscv64`. This workspace's
pnpm overrides remove ARM/RISC-V esbuild binaries, so only **Linux x86_64 is a
candidate**, not a tested supported platform. If hardware is ARM, stop and
deliberately revise/test the upstream lock/overrides; do not claim multiarch.
The manifest reference documents RAM in **bytes**, e.g. `4 * 1024 ** 3`; no
measured memory floor is asserted here. Reported 32 GB is not a compatibility
certificate or a resource reservation. Storage has no verified SDK gate here:
measure dump size, DB/WAL growth, temporary ciphertext staging, and restore
space and alert on low space; leave room for OS/other services.

## Supplied external container sources

Build on a trusted Linux Docker/Buildx workstation or controlled GitHub runner,
**not Replit**. Use repository root as context, each specified Dockerfile,
the exact reviewed source commit, frozen pnpm lock, pnpm **10.26.1**, Node **24**,
and PostgreSQL **16**. Only API and its DB/Zod workspace source is copied; no
workspace-wide COPY, `.env`, secrets, frontend build, or generated live data.

External command templates (these commands have NOT been run):

```sh
docker buildx build --platform linux/amd64 --load \
  -f ops/startos/Dockerfile.api -t lek-mint-api:reviewed .
docker buildx build --platform linux/amd64 --load \
  -f ops/startos/Dockerfile.postgres -t lek-mint-postgres:reviewed .
docker buildx build --platform linux/amd64 --load \
  -f ops/startos/Dockerfile.backup -t lek-mint-backup:reviewed .
```

These default to mutable major-version base tags **for preparation only**.
Before production, verify registry architecture manifests and supply immutable
`NODE_IMAGE=node:24-...@sha256:...` and
`POSTGRES_IMAGE=postgres:16-...@sha256:...` build arguments, record patch versions,
pin backup-tool packages/base snapshot or artifact digest, scan image/SBOM,
and pin final image digest in the real SDK manifest. No secret build arguments.
The Node build uses `--frozen-lockfile`; deployment uses pnpm 10's legacy deploy
to retain external runtime dependencies such as nodemailer and pino workers.
This build/deploy path still requires an external actual container build test.

## Required real package runtime contract

Translate this contract into a scaffold from the **verified matching SDK**;
it is not a StartOS schema or a ready-to-sideload package:

| Item | Contract |
| --- | --- |
| PostgreSQL image | `Dockerfile.postgres`, PostgreSQL 16 |
| PostgreSQL volume | durable volume mounted `/var/lib/postgresql/data`; `PGDATA=/var/lib/postgresql/data/pgdata`; never ephemeral |
| API image | `Dockerfile.api`, non-root Node 24, port 3000 |
| operation mode | explicitly `standby` on install, restore, recovery, and every upgrade; activation is a separate confirmed operator action |
| credentials | protected config volume; exact `SESSION_SECRET`, `ADMIN_API_KEY`, and `DATABASE_URL` files, no CLI strings/logs |
| API env | `DATABASE_URL_FILE`, `SESSION_SECRET_FILE`, `ADMIN_API_KEY_FILE`; explicit `MINT_OPERATION_MODE`; origins, actual trusted proxy boundary, external services |
| DB network | private/local only; port 5432 never exported as public interface |
| API network | HTTPS public API interface; LAN/Tor-only is insufficient for Netlify browser/Cashu clients |
| backup image | one-shot `Dockerfile.backup`, no privileged host access; mounted PG credential/config files, public age recipients, private encrypted output volume, local rclone config |
| backup restore | manual separate action using `bash /opt/lek-backup/restore.sh`; no promoted API; mount private age identity only during recovery |
| startup | PostgreSQL ready SQL probe, then API; no schema push, seed, genesis, metrics repair, key creation/rotation in package startup/init |
| health | DB `pg_isready` plus authenticated `SELECT 1`; API liveness `/api/healthz`; financial readiness `/api/readyz` only active + DB probe |
| shutdown | drain/fence API and wait for in-flight transactions/background workers, then close DB pool, then PostgreSQL fast graceful shutdown (SIGINT); no SIGKILL unless incident procedure |

`api-entrypoint.sh` reads mounted files **without trimming** and rejects empty
values, invalid permissions, absent files, conflicting env credentials, and
invalid modes. Store raw UTF-8 values without adding a trailing newline. Preserve exact
original `SESSION_SECRET` bytes: they decrypt the existing xpub and all stored
mint keysets. A new random secret on restore destroys access to existing keys.
File UID must allow the Node user to read; group/other permissions must be zero.
The launcher forwards SIGTERM/SIGINT to Node; real drain behavior is supplied
by the API's operation-mode/shutdown implementation and must be verified.
The documented wrapper uses a Node child supervisor, so the final StartOS
daemon must validate process/signal behavior, including `runAsInit` if needed.

The PostgreSQL wrapper deliberately refuses empty/missing `PG_VERSION` and
non-16 clusters instead of auto-initializing. Its image uses the upstream
entrypoint for existing-cluster ownership/user switching. In StartOS these
paths and subcontainer shared network/socket semantics must be verified;
loopback access between images is a required test, not an assumption. Default
PostgreSQL durability flags stay on. Budget memory conservatively; do not tune
`shared_buffers` from the reported RAM alone or disable fsync for speed.

### Fresh installation is not restore

1. Keep API fenced/standby and disconnected from production routing.
2. Explicitly choose **new mint** versus **recovery of existing mint**.
3. New mint: operator separately authorizes creation of a fresh PostgreSQL
   cluster/database/least-privilege roles and SCRAM authentication, with private
   data ownership. There is no automated init action in these sources.
4. For a genuinely new empty database only, review schema changes at the pinned
   commit and deliberately run the existing `@workspace/db` schema tooling from
   a controlled environment. Do not use `push-force`, seed, or start active just
   to make a restore boot. No database/schema init runs from these Dockerfiles.
5. Existing mint: create an isolated fresh recovery DB and restore the complete
   logical dump as described in `../backup/README.md`; it carries schema, data,
   sequences, constraints/indexes. Do not run Drizzle push or seeds over it.
6. DB roles/grants are outside the dump. Recreate reviewed least-privilege
   roles deliberately, map ownership, and verify privileges before activation.
7. Unlock existing secrets offline; verify **all** historical keysets and xpub
   decryption without printing material. Never generate substitute keys.

## Exact pending validation before any production move

- Confirm exact installed **StartOS 0.4.0.1**, CPU and `uname -m`, storage health,
  boot/restart behavior, power protection, available RAM/disk and network.
- Obtain compatible Start9 CLI/SDK release from official release/schema source,
  pin version + lock/checksums, scaffold outside this workspace using official
  `start-cli s9pk init-workspace` and `start-cli s9pk init-package`, and typecheck.
  Obtain official schema details for mounts, credentials, lifecycle, interfaces,
  `runAsInit`, task/action confirmations, and backup behavior at that release.
- Supply repository URL/license/icon and release metadata; verify all image
  digests/architectures; build and validate signed package with matching CLI.
- Implement config/actions with explicit standby defaults and human promotion,
  durable DB/config/backup-state mounts, dependency ordering, SQL health probe,
  reverse shutdown order, and action interlocks. Do not expose secrets via UI
  properties, errors, saved action input logs, or daemon command arguments.
- Make native StartOS backup exclude live raw PGDATA unless the SDK integration
  demonstrably coordinates quiescence/consistent physical backup. The provided
  logical age stream is the supported planned backup path; raw copied PG files
  while running are **not** a valid consistent backup.
- Install on an isolated actual OS device; exercise standby/maintenance/active
  gates and worker suppression, DB disconnect readiness, signal drain, restart,
  reboots/persistence, exact secret decryption, no boot schema mutations,
  scoped CORS/HTTPS proxy/security headers and reachability from Netlify.
- Provision protected Start9-local rclone Google OAuth, recipient/offline
  identity recovery, monitor/manual schedule and failures; test genuine age +
  pg_dump + Drive + isolated pg_restore against **synthetic test state** first.
- Conduct approved final migration/recovery drill and the financial/manual
  single-writer checklist below. Old provider state must be complete at cutover.

Shell/static tests: `bash ops/startos/test.sh` and `bash ops/backup/test.sh`.
They use only refusal checks/fixtures, not a running app/DB/cloud. Main agent
owns application mode and runtime integration tests.

## Manual Replit recovery and failback

See `../backup/README.md` for the full procedure and actual financial invariants.
Never route writes between Start9 and Replit based on latency/HTTP health/backup
age. Keep only one financial writer; if the lost primary's final committed
ledger cannot be established, remain in maintenance even if that takes days.