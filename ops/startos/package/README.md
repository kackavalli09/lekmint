# Real Lek Mint package — isolated build candidate

This is **not a production release or an installation instruction**. It packages
the actual mint API and PostgreSQL 16, not the earlier hello-world sample.
Its distinct ID is `lek-mint-lab`. It cannot serve transactions: standby is
hardcoded, no activation action exists, and no network interfaces are exported.
Database initialization is never automatic. An empty installation will not
start successfully; this is an intentional refusal, not an invitation to seed
or restore production state.

## Verification and boundaries

The package was checked against the actual patched SDK declarations, not just
the moving template. TypeScript checks and the JavaScript bundle build passed.
The package tooling's complete npm audit reported zero vulnerabilities.
Contract/refusal tests exercise the compiled exports and configuration.

The operator reports a successful external Docker/image and `.s9pk` build;
see [BUILD-RECORD.md](BUILD-RECORD.md) for the supplied manifest and checksum.
These builds were not run in this workspace, and real-device operation remains
untested. The application's separate dependency findings are unresolved.
Base images still use major-version tags for preparation; pin digests and scan
the finished images before a production candidate. No production cutover,
automatic backup configuration or activation is included.

## Build on the existing Windows/WSL workstation

1. Download the reviewed migration branch as a ZIP from the private GitHub
   repository, or fetch that branch into a **new** source checkout. Do not
   overwrite the successful sample or its `.startos` signing keys.
2. Put this source tree inside the existing `~/lek-start9-build.…/` workspace,
   alongside (not inside) `lek-build-check-startos`. Keep the whole repository
   layout: image build paths are relative to this package directory.
3. Use the previously checksum-verified CLI 1.1.0 shim in that workspace's `bin`
   directory. Keep the workspace's dummy default host disabled; do not replace
   it with a real Start9 address. No server target is needed for packaging.
4. In Ubuntu, enter the extracted source repository and run:

   ```bash
   export PATH="/actual/path/to/lek-start9-build.…/bin:$PATH"
   bash ops/startos/package/build-local.sh
   ```

The script regenerates the checksum-pinned SDK archive, uses the committed npm
lockfile, audits, typechecks, bundles, runs package checks, and builds only
`lek-mint-lab_x86_64.s9pk`. It does not install or publish. Docker must be
available in WSL. If any command fails, stop and send the first error.
Do not use `--force` on npm audit or regenerate the lockfile to bypass an
integrity failure. Python/zlib differences can change archive compression;
if npm rejects the local archive checksum, report it for review.

Save the final manifest output, package checksum, build source revision, audit
summary and image digests together. ZIP checkouts can report `gitHash: null`;
that is not source provenance, so retain the exact downloaded commit separately.
Do not distribute this private build or upload keys/configuration files.

## After the build — separate approval required

Before any device installation: review image/container audits, shutdown signal
behavior, shared loopback networking, config ownership, package signature and
volume semantics. See [instructions.md](instructions.md) for the runtime
contract and [../README.md](../README.md) for the remaining migration gates.

A later isolated device drill needs synthetic data and protected synthetic
credentials. It must verify persistence/reboot, credential handling, ordered
startup and graceful shutdown, and that transaction endpoints remain refused.
Testing active mint transactions needs a separately reviewed test harness;
this package intentionally provides no promotion switch.

Native backups/restores fail explicitly rather than pretending empty backups
or raw live PostgreSQL files are valid. Encrypted logical backups remain a
separate integration and are not scheduled by this candidate.