# Packaged-filesystem scan review

## Evidence and disposition

The operator extracted and scanned both filesystems from the previously recorded
package, whose SHA-256 check passed:
`6167c7f3ea52082fcb385e33bd12af0b93fb6fceea86693a325cc5d314114dc5`.

Trivy 0.75.0 scanned Debian 12.15 OS packages and language packages. Its downloaded
database was updated at 2026-10-03 19:02:38 UTC. The operator supplied both complete
JSON reports, which were reviewed here. These are external scan results, not a
device execution test. Full reports remain in the uploaded project assets and
on the operator's machine.

**Hold installation/activation.** Scanning is complete for this candidate, but
remediation and applicability review are not. No application, dependency,
database or image build changes were made as part of this review.

## Raw counts

Counts are package/advisory occurrences, not independent exploits. One advisory
may appear against multiple binary packages or multiple installed copies.

| Scope | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| API — OS | 4 | 53 | 101 | 75 | 2 |
| API — application dependencies | 0 | 3 | 13 | 0 | 0 |
| API — global npm dependencies | 0 | 8 | 11 | 1 | 0 |
| **API total** | **4** | **64** | **125** | **76** | **2** |
| PostgreSQL image — OS | 15 | 81 | 191 | 161 | 5 |
| PostgreSQL image — gosu Go binary | 1 | 21 | 21 | 2 | 1 |
| **PostgreSQL image total** | **16** | **102** | **212** | **163** | **6** |

## Prioritized remediation candidates

### Actual application dependencies

- `ip-address` 10.2.0: one high and six medium findings in `/app/node_modules`.
  10.3.1 addresses the high alone; the reports list fixes through 10.7.1 for the
  medium findings. Select a compatible version covering all of them, not just
  the high. Test IPv4/IPv6 normalization, invalid addresses, proxy handling and
  rate-limiter behavior.
- `nodemailer` 9.0.5: two high and five medium findings in `/app/node_modules`.
  The reported fixes extend through 10.0.6. This crosses a major-version boundary;
  review compatibility and test SMTP behavior and failure handling before
  adopting it. The current API mail path is admin-protected with an
  operator-configured recipient; this does not make the dependency safe.
- `qs` 6.15.3: two medium findings; reported fix 6.16.0. Check the parent
  dependency and query parsing behavior rather than forcing an untested override.

Use current release/advisory data when implementing. Listed versions are scanner
fix suggestions, not tested upgrade recommendations.

### Global npm bundled into the runtime base image

Eight high findings are under `/usr/local/lib/node_modules/npm`, not the
application dependency tree: four brace-expansion findings and one each for
http-cache-semantics, ip-address, tar and undici.

In particular, brace-expansion 5.0.7 here is npm's bundled copy. It is not evidence
that the workspace's 5.0.12 override failed. Workspace overrides do not change
global npm in the base image.

The API entrypoint runs Node directly. Consider removing unused package-manager
tooling from the final runtime stage only, preserving build-stage tools and
runtime libraries. Verify the resulting image starts and passes health checks.

### PostgreSQL startup helper

The scanned Go binary is `/usr/local/bin/gosu` (gosu 1.19.0, built with Go
1.24.6), not the PostgreSQL server binary. Its standard library accounts for one
critical and 21 high findings. These package-level findings do not prove the
affected Go networking code is reachable through gosu.

The wrapper delegates to the official PostgreSQL entrypoint; do not simply
delete gosu, which is involved in dropping privileges. Prefer an updated,
verified base image/helper and explicitly test unprivileged startup, ownership,
existing-data refusal checks and clean shutdown. Preserve PostgreSQL major 16.

### Debian findings require individual applicability review

None of the OS critical/high rows lists a fixed version in these reports.
That does not mean patches can never become available, nor that every row is
exploitable here. A blind rebuild or general package upgrade is not a guaranteed
solution.

Example: CVE-2023-45853 is reported against `zlib1g` in both images.
[Debian's official tracker](https://security-tracker.debian.org/tracker/CVE-2023-45853)
states that Bookworm's zlib source does not build the affected contrib/minizip
code and the corresponding older-suite binary packages are not affected.
Document this distro-specific applicability evidence rather than removing zlib
or hiding critical findings generally. No standalone minizip package appears in
the supplied inventories.

The Perl critical findings include a description explicitly referring to 32-bit
builds, while this package targets x86_64. Confirm architecture and vulnerable
component presence before accepting an exception. Other Perl, SQLite and XML
findings still need their own review. Repeated Perl rows in the PostgreSQL image
are not separate unique CVEs.

## Verification before advancing

1. Make targeted changes without changing ledger, mint-key, wallet or database
   semantics; do not switch distribution or PostgreSQL major just to reduce
   scanner counts.
2. Verify dependency compatibility and relevant regressions locally.
3. Rebuild externally from reviewed source and record fresh package/base-image
   provenance; the old checksum and scans do not cover changed images.
4. Scan the rebuilt package and retain full results plus evidence for any
   accepted applicability exceptions.
5. Only then consider separately authorized isolated Start9 installation and
   runtime tests. Production cutover remains a separate decision.