# Operator-reported isolated package build

The operator supplied a successful pack/manifest-inspection/checksum result
and final npm audit. This is external evidence supplied by the operator, not
a package downloaded, inspected or executed in this workspace.

- Filename: `lek-mint-lab_x86_64.s9pk`
- Package ID: `lek-mint-lab`
- Version: `1.1.1:0`
- SDK: `2.0.9-lek.1`
- API and PostgreSQL image sources: `packed`, both `x86_64`
- Volumes: `config`, `postgres`
- Git hash: `null` (ZIP source with locally applied packaging fixes)
- Manifest OS version: `0.4.0-beta.10`
- Final package-tooling npm audit: `found 0 vulnerabilities`
- Reported SHA-256:
  `6167c7f3ea52082fcb385e33bd12af0b93fb6fceea86693a325cc5d314114dc5`

## Interpretation

Packaging succeeded. This checksum identifies this particular reported build;
it is not a guarantee of deterministic reproduction or a signature verification.
The original ZIP plus local registry URL, Dockerfile path and assets-directory
fixes are the source history; the manifest itself does not attest a Git commit.

The OS-version field is emitted by the consumed SDK. The subsequent
[source-level compatibility review](COMPATIBILITY-SECURITY-REVIEW.md) found it
inside the official 0.4.0.1 compatibility range. Device operation and security
clearance remain unverified; do not rewrite the field to match the device label.

No installation, device health, volume persistence, shutdown behavior,
transaction correctness, backup recovery, or production cutover is verified.
The clean tooling audit does not audit the bundled application runtime or
container OS. Keep the package and workspace intact pending image/security and
compatibility review; do not load production state or activate transactions.