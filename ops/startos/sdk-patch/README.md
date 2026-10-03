# Reproducible Start9 SDK dependency patch

This is an **unofficial dependency-only repack**, not a Start9 release.
The operator approved maintaining it until a suitable upstream release exists.
Do not apply it to the live mint or install a service merely because it builds.

## What changes

The checked-in Python recipe verifies SHA-512 integrity for every download.
It repacks SDK 2.0.9 as **2.0.9-lek.1**, replacing exactly:

| Bundled location | Old | New |
| --- | --- | --- |
| @eslint/config-array → brace-expansion | 1.1.15 | 1.1.21 |
| @eslint/eslintrc → brace-expansion | 1.1.15 | 1.1.21 |
| eslint → brace-expansion | 1.1.15 | 1.1.21 |
| @typescript-eslint/typescript-estree → brace-expansion | 5.0.6 | 5.0.12 |
| @eslint/eslintrc → js-yaml | 4.2.0 | 4.3.2 |

All replacement dependency requirements match the originals. SDK/core source
and all files outside these package subtrees are byte-preserved, except root
package version metadata and an added provenance file. Replacement package
licenses are retained. No dependency is deleted merely to hide an advisory.

The recipe rejects checksum mismatches, changed layouts, unexpected versions,
changed dependency requirements, unsafe paths, archive links, and different
pre-existing outputs. It never edits an installed node_modules tree, accesses
mint credentials, or contacts a StartOS device.

## Local preparation

Prerequisites: Python 3, internet access to the public npm registry.
From a checkout of the reviewed source:

```sh
python3 -m unittest discover -s ops/startos/sdk-patch -p 'test_*.py'
python3 ops/startos/sdk-patch/prepare.py --output-dir /path/to/sample/vendor
```

The output is `start9labs-start-sdk-2.0.9-lek.1.tgz` with a SHA-256 sidecar.
Timestamps, file ordering, ownership, and gzip filename are normalized.
Repeated runs were byte-identical on the verification host. For byte-identical
compression across machines, use the same Python/zlib toolchain; the pinned
input integrity and replacement checks remain required regardless.

## Apply only to the local sample package

1. Back up the sample's package.json and package-lock.json outside its directory.
   Preserve the workspace's signing keys; do not upload `.startos`.
2. Generate the archive into the sample's `vendor/` directory.
3. Inside the sample, run:

   ```sh
   npm install --ignore-scripts --save-exact ./vendor/start9labs-start-sdk-2.0.9-lek.1.tgz
   npm audit
   npm run check
   make -B x86
   ```

   Run these sequentially and stop on any failure. Ensure the version-named
   CLI 1.1.0 shim in the build workspace's `bin/` is on PATH.
   `make -B` prevents reusing the old vulnerable sample artifact.
4. Verify node_modules/@start9labs/start-sdk/package.json reports 2.0.9-lek.1.
5. Keep the patched archive, package.json, package-lock.json, recipe and
   provenance together. A fresh checkout must use `npm ci` with this local
   archive present; it must not silently reinstall the official unpatched SDK.
6. Re-audit after the forced rebuild. An audit failure or registry error is a
   blocker, not a reason to use `--force`, omit dev packages, or suppress findings.

## Verification completed here and remaining gates

- Six recipe tests passed (integrity refusal, unsafe archives, deterministic
  roundtrip, five replacements, layout guard, dependency-requirement guard).
- Real pinned npm downloads passed SHA-512 checks; two repacks produced the same
  archive, SHA-256 `d6d62625f8c0bc2ceecba28fa77d3ff4116bd674ca7466fcba87c9e2ce0fdedd`.
- All four actual replacement brace-expansion copies passed a normal expansion
  smoke check; the replacement js-yaml passed a normal parsing smoke check.
- The public npm bulk advisory endpoint returned no advisories for the 117
  distinct package names/versions found **inside the patched archive**.
  This is not an audit of all dependencies subsequently installed by npm, does
  not establish runtime exploitability, and does not cover container OS packages.

The operator subsequently reported a successful forced x86_64 sample rebuild
using SDK 2.0.9-lek.1 and a final npm audit reporting zero vulnerabilities.
The output was `lek-build-check_x86_64.s9pk` (4.1M). This is operator-reported
external verification, not a build executed in this workspace.
No device compatibility, real mint packaging, database restoration, public
ingress, or production activation is certified. The sample audit does not
clear the separate application's dependency findings or container OS packages.

When upstream releases a fix, verify its actual bundled contents, test the
migration back to the official dependency, and remove this patch deliberately.