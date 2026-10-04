# Targeted security rebuild — not installation approval

Application fixes select Nodemailer 10.0.13, express-rate-limit 8.7.0,
ip-address 10.7.3 and qs 6.16.0. Nodemailer 10.0.14 was newer than the workspace's
minimum release age; that safeguard was preserved. The standalone monitor
uses the same Nodemailer version with a portable npm lockfile.

The final API image no longer includes global npm/Corepack tools. The build
stage still has package management. PostgreSQL remains 16 on Bookworm. Its gosu
1.19 source is pinned to an upstream commit and rebuilt using Go 1.26.8, with a
build-time assertion that it can still drop to the postgres user.

The external build script refreshes all three base images and records their
IDs/digests. It never installs to Start9. Keep the previous source/package
untouched; unpack the updated source in a separate directory inside the same
existing Start9 build workspace so its CLI configuration/signing identity remains
available.

## Local evidence

- API typecheck and production bundle passed.
- Synthetic tests passed for email generation and transport-error propagation,
  normal/prototype-pollution query parsing, IPv4/IPv6 rate-limit keys, and HTTP
  rate limiting with spoofed forwarding headers.
- Isolated operation-mode checks passed for standby, maintenance, active and
  shutdown behavior using unreachable fixture DB credentials.
- Three startup refusal checks and 21 package/monitor tests passed.
- Fresh workspace dependency audit: 0 critical, 11 high, 4 moderate, 1 low;
  no findings returned for nodemailer, ip-address or qs.
- API restarted in standby with ledger routes/jobs disabled.

No mint cryptography, wallet behavior, ledger implementation or DB schema was
edited. No real transaction, database mutation or SMTP delivery was used for
these tests. This is not full financial end-to-end or real SMTP verification.

## External steps

1. Download the reviewed migration-branch source as a fresh archive; do not
   overwrite the old build. Run `bash ops/startos/package/build-local.sh` from
   the new repository directory with the existing workspace CLI on PATH.
2. Keep `build-base-images.txt`, the complete build log and new package checksum.
   The previous package checksum must not be reused as an expected hash.
3. From the existing Start9 workspace, run:

   `bash NEW_SOURCE/ops/startos/package/scan-built-package.sh NEW_PACKAGE NEW_SHA256`

   Replace those three arguments with the actual new paths/checksum. The scanner
   verifies that checksum and scans embedded filesystems rather than temporary
   Docker tags. Retain both JSON reports and scanner-version/hash files.
4. Review any remaining OS/advisory applicability. Do not blanket-ignore unfixed
   findings, delete essential system packages or treat a successful build as
   runtime or security clearance.

## Operator-reported rebuild result

The operator reported a successful fresh build and both filesystem scans using
Trivy 0.75.0 and the same database updated at 2026-10-03 19:02:38 UTC as the first
scan. Reported counts:

| Image | Critical | High | Medium | Low | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| API | 4 | 53 | 101 | 75 | 2 |
| PostgreSQL | 15 | 81 | 191 | 161 | 6 |

This is 81 fewer package/advisory occurrences overall: 1 critical, 32 high,
45 medium and 3 low removed. The reduction is consistent with the targeted
changes. The subsequent full-report review below confirms their locations.
Do not interpret reduced counts as device runtime or security clearance.

### Full-report verification

Both replacement JSON reports and scanner-version metadata were received and
compared against the original inventories. The supplied package checksum is:

`f1e43c3d96702f5099dd34a7a6b3e2653d33869c91c2f20c73a626500a0490e4`

This identifies the operator-reported rebuilt package, not a package independently
downloaded or executed here. The operator subsequently supplied the missing
build-base-images.txt output:

| Build input | Reported image ID | Reported repository digest |
| --- | --- | --- |
| node:24-bookworm-slim | `sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` | `node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` |
| postgres:16-bookworm | `sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67` | `postgres@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67` |
| golang:1.26.8-bookworm | `sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d` | `golang@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d` |

These are retained verbatim as operator-reported build-input identities, not
independent registry verification or a signed attestation linking the inputs
to the package. Golang is the gosu build stage, not a third runtime service.

- API Node inventory: 119 packages, zero reported vulnerabilities. It contains
  ip-address 10.7.3, Nodemailer 10.0.13 and qs 6.16.0. All 36 former Node-package
  findings are absent.
- PostgreSQL inventory: server 16.15. The gosu binary records the pinned source
  commit and Go 1.26.8. Its 45 formerly critical/high/medium/low findings are
  absent. One unknown-severity x/sys finding remains.
- No new findings were added when comparing target type, advisory ID, package
  name and package path. All OS findings are unchanged.
- Remaining critical/high occurrences are OS-package findings: API 4/53,
  PostgreSQL 15/81. These are not security clearance or proof of exploitability.

### Additional applicability evidence

The remaining gosu finding, CVE-2026-39824 / GO-2026-5024, concerns
NewNTUnicodeString in golang.org/x/sys/windows. The official Go advisory
explicitly scopes it to `goos: windows`. This is not applicable to the Linux
gosu build. Retain the raw finding and this platform-specific rationale; do not
blanket-ignore unknown-severity findings.

Source: https://vuln.go.dev/ID/GO-2026-5024.json

The six distinct critical OS advisory IDs were checked against Debian's tracker:

- CVE-2023-45853: Bookworm zlib binary applicability exception documented in the
  earlier image review.
- CVE-2026-8376: upstream description restricts the overflow to 32-bit Perl;
  the operator's read-only ELF-header checks report 64-bit `/usr/bin/perl`
  in both extracted images. This supports a not-applicable disposition for
  those executables, based on the advisory's stated 32-bit scope. It does not
  clear other Perl advisories or change the raw scan counts.
- CVE-2026-13221: tracker marks Bookworm vulnerable, but its notes say the issue
  was introduced in Perl 5.37.10 while installed Perl is 5.36.0. This conflicting
  evidence requires further investigation, not an automatic exception.
- CVE-2026-42496: Archive::Tar symlink extraction issue; Bookworm fix postponed.
  The operator's filesystem search found no `Archive/Tar.pm` in the API image
  and found `usr/share/perl/5.36.0/Archive/Tar.pm` in PostgreSQL. This supports
  component absence for the API's searched filesystem, not blanket Perl
  clearance. PostgreSQL component presence is confirmed; vulnerable-code
  reachability and disposition remain open.
- CVE-2025-7458: SQLite crafted SQL issue; Bookworm vulnerable, no DSA planned.
  Review actual consumers/SQL access rather than treating SQLite as the mint DB.
- CVE-2026-6653: libxml2 malformed XML use-after-free; Bookworm fix postponed.
  Trixie is also marked vulnerable, so changing distribution is not a blanket fix.

Each source is https://security-tracker.debian.org/tracker/ followed by the CVE
identifier. No remaining critical/high OS row lists a fixed version in these
reports. That is not a guarantee that updates cannot later become available.

The subsequent [full critical/high OS review](OS-APPLICABILITY-REVIEW.md) covers
all 32 distinct advisories and identifies a current Bookworm PCRE2 security fix
not listed in those saved reports. Updating both runtime copies to
10.42-1+deb12u2 or a later compatible security revision is now implemented in
the runtime build recipes, but not externally built or scanned. The existing
package still contains the older version. See IMAGE-EVIDENCE-CHECK.md for the
read-only evidence script and build-verification limits.
Other findings have scoped exclusions or explicit unresolved
conditions; none are blanket-suppressed.

External build/scan completion and the targeted dependency fixes are confirmed
by operator evidence, with base-image identities now recorded. Remaining OS applicability,
device-level startup/shutdown, real SMTP and isolated transaction/recovery
tests remain pending.
Do not install, activate, change DNS or supply production secrets.