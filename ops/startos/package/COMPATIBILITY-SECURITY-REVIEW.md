# Pre-install review — installation remains unapproved

## Version compatibility

The consumed SDK explicitly labels `OSVersion = 0.4.0-beta.10` as its minimum
required StartOS version. This is not the installed device version.

In the official `start-os/v0.4.0.1` release source:

- The package selector checks whether the manifest's required OS version
  satisfies the device's advertised compatibility range.
- The 0.4.0.1 version implementation returns `V0_3_0_COMPAT`.
- That range is inclusive from 0.3.0 through the current OS version (0.4.0.1
  for this release).

The bundled SDK's version comparator confirms that `0.4.0-beta.10` falls inside
that range. The beta-labelled field therefore is **not itself a version blocker
for the reported target release**. Do not rewrite it to match the device label.
This is source-level compatibility evidence, not a device installation/runtime
test or independent verification of the operator's installed OS.

Sources:
- https://github.com/Start9Labs/start-technologies/blob/start-os/v0.4.0.1/shared-libs/crates/start-core/src/s9pk/rpc.rs
- https://github.com/Start9Labs/start-technologies/blob/start-os/v0.4.0.1/shared-libs/crates/start-core/src/version/v0_4_0_1.rs
- https://github.com/Start9Labs/start-technologies/blob/start-os/v0.4.0.1/shared-libs/crates/start-core/src/version/v0_3_5.rs
- Consumed SDK: `lib/StartSdk.js`, `lib/manifest/setupManifest.js`, and bundled
  start-core version comparator.

## Fresh workspace scans

Dependency scan timestamp: 2026-10-04 UTC.

| Scanner | Result |
| --- | --- |
| Dependency audit | 0 critical, 14 high, 16 moderate, 2 low |
| Static code scan | 0 findings; reported complete |
| Privacy/dataflow scan | 0 findings returned |

Empty code-scan results do not certify the code is secure. These scanners do
not inspect the operator's actual Docker image layers or package artifact.

### Priority runtime findings

- **Nodemailer 9.0.5:** two high denial-of-service advisories in address parsing,
  GHSA-2x7j-588g-ccc2 and GHSA-v53p-9fqp-m79j. Scanner fix suggestions differ:
  9.1.0 for one and 10.0.6 for the other; upgrading only to 9.1.0 would not clear
  both according to this scan. It is an API production dependency and used in
  the monitor. The currently inspected API call sends to the configured
  operator through an admin-protected route, reducing direct public exposure
  on that path, but not eliminating the vulnerable dependency. Review a
  compatible fixed version and email regression coverage before changing it.
- **ip-address 10.2.0:** high advisory GHSA-mwp4-54f8-5fhr concerning inconsistent
  interpretation of leading-zero IPv4 octets; suggested fix 10.3.1. Production
  dependency through express-rate-limit. Assess actual rate-limiter usage and
  test address normalization; the advisory alone does not prove an exploitable
  SSRF path in this application.

Other high findings: braces, browserslist, fast-uri and postcss. These did not
appear in the API package's dependency paths from `pnpm why`; several are build
tool dependencies. Confirm the final image inventory rather than assuming all
are absent or dismissing build-time risks.

No dependency versions or application behavior were changed during this review.

## Image review remains pending

The reported `.s9pk` is on the operator's PC. Its exact image contents have not
been scanned here. First collect local API/PostgreSQL image IDs and scanner
availability, then scan the relevant built images including OS and language
packages, recording image IDs, scanner/database versions and complete reports.
Do not scan only base tags, select a random old build, upload private images,
mount production state or start the application to perform an image scan.

Retain the package SHA-256 from BUILD-RECORD.md. Multiple local build tags may
refer to identical image IDs; account for all candidates if the exact packaged
image mapping cannot be established. A locally cached image listing alone does
not prove which image bytes are embedded in the package.

## Decision

Version-field concern resolved at source level. Security review is **not clear**:
runtime dependency findings and built-image scans remain outstanding. Keep the
candidate uninstalled and in standby; no live migration or activation approval.