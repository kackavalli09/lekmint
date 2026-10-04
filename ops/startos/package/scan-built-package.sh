#!/usr/bin/env bash
# Run on the operator's Linux/WSL build machine, without sudo.
# Usage: bash scan-built-package.sh PACKAGE.s9pk EXPECTED_SHA256
set -euo pipefail
umask 077
trap 'echo "Scan stopped at line $LINENO. Keep the output; do not install the mint." >&2' ERR
PKG="$(realpath "${1:?Pass the built package path}")"
EXPECTED="${2:?Pass the recorded package SHA-256}"
[[ "$(uname -m)" == x86_64 ]] || { echo "This scanner download requires x86_64."; exit 1; }
for tool in start-cli unsquashfs curl tar sha256sum python3; do command -v "$tool" >/dev/null; done
printf '%s  %s\n' "$EXPECTED" "$PKG" | sha256sum -c -
BUILD_CWD="$PWD"
start-cli s9pk inspect "$PKG" file-tree >/dev/null
SCAN_DIR="$(mktemp -d "$HOME/lek-mint-image-scan.XXXXXX")"
echo "Reports and extracted files: $SCAN_DIR"
cd "$SCAN_DIR"
sha256sum "$PKG" > package.sha256
curl --fail --location --retry 3 -o trivy.tar.gz \
  https://github.com/aquasecurity/trivy/releases/download/v0.75.0/trivy_0.75.0_Linux-64bit.tar.gz
echo 'c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f  trivy.tar.gz' | sha256sum -c -
tar -xzf trivy.tar.gz trivy
export TRIVY_CACHE_DIR="$SCAN_DIR/cache"
for image in api postgres; do
  (cd "$BUILD_CWD" && start-cli s9pk inspect "$PKG" cat "images/x86_64/$image.squashfs") > "$image.squashfs"
  sha256sum "$image.squashfs" >> filesystems.sha256
  unsquashfs -no-xattrs -no-progress -d "$SCAN_DIR/$image-rootfs" "$image.squashfs"
  ./trivy rootfs --disable-telemetry --offline-scan --scanners vuln \
    --pkg-types os,library --timeout 20m --exit-code 0 --format json \
    --output "$SCAN_DIR/$image-report.json" "$SCAN_DIR/$image-rootfs"
done
./trivy --version | tee scanner-version.txt
python3 - <<'PY' | tee summary.txt
import collections, json
for image in ("api", "postgres"):
    with open(f"{image}-report.json") as f:
        report = json.load(f)
    results = report.get("Results") or []
    findings = [v for r in results for v in r.get("Vulnerabilities") or []]
    print(f"\n=== {image.upper()} ===")
    print("Detected OS:", report.get("Metadata", {}).get("OS"))
    print("Findings:", dict(collections.Counter(v["Severity"] for v in findings)))
    print("Scan targets:", [(r.get("Class"), r.get("Type")) for r in results])
    high = sorted({
        (v["Severity"], v["PkgName"], v["InstalledVersion"], v["VulnerabilityID"],
         v.get("FixedVersion") or "no fix listed")
        for v in findings if v["Severity"] in ("CRITICAL", "HIGH")
    })
    for row in high[:20]:
        print(" | ".join(row))
    if len(high) > 20:
        print(f"... {len(high) - 20} further high/critical rows in the JSON report.")
PY
echo "=== SCAN FINISHED: $SCAN_DIR ==="