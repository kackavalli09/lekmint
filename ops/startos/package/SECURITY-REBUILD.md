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

Docker compilation, gosu privilege behavior, rebuilt-image scans, real SMTP,
device operation and isolated transaction/recovery tests are still pending.
Do not install, activate, change DNS or supply production secrets.