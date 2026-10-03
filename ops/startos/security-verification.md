# Dependency patch verification — not cutover approval

## Application dependency changes

- Orval is pinned to 8.22.0, addressing its reported advisory without adopting
  later generator behavior changes.
- Compatible overrides select brace-expansion 5.0.12 and js-yaml 4.3.2.
- The generated implementation is unchanged: all 83 changed generated files
  differ only in their generator-version comments.
- No wallet, ledger, mint key, database schema, route, or financial operation
  implementation was changed for this dependency update.

## Checks completed

- API code generation and library typechecks.
- Full workspace typechecks and all workspace production builds.
- StartOS source syntax and three refusal checks.
- Twenty mocked backup/restore checks.
- Fourteen monitor and four Netlify routing/configuration tests.
- Isolated active, maintenance, and standby operation-gate/shutdown tests.
- Six SDK repack recipe tests.
- Restarted API, wallet and admin services; startup succeeded. Wallet preview
  renders with the expected standby banner. HTTP 503 on ledger/readiness routes
  is intentional while standby is enabled, not a regression introduced by this patch.

No real mint transaction was made and no live data was altered for these checks.
These results do not prove every end-to-end transaction or device behavior.

## Dependency audit

The post-update scanner reports no findings for brace-expansion, js-yaml, or
Orval. The overall dependency scan is **not clean**: it reports 0 critical,
14 high, 16 moderate and 2 low advisory findings. Advisory counts are not counts
of proven exploitable application paths.

Remaining high findings involve braces (a different package from
brace-expansion), browserslist, fast-uri, ip-address, nodemailer and postcss.
Some are runtime dependencies; separately assess reachability, compatible fixes
and regression coverage before production cutover. Do not dismiss them all as
development-only or treat the two original fixes as overall security clearance.

## Remaining external checks

Follow [the SDK patch guide](sdk-patch/README.md) to apply the reproducible
archive to the local sample project, audit its complete installed dependency
tree, force a fresh build, and audit again.

The final mint package, container/OS scans, actual Start9 compatibility,
isolated restore and transaction tests remain pending. No publishing, device
installation, DNS change, or mint activation is authorized by this document.