#!/usr/bin/env bash
# External WSL/Linux only. Builds locally; never installs or publishes.
set -Eeuo pipefail
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
for cmd in python3 npm node make docker start-cli; do
  command -v "$cmd" >/dev/null || { echo "Missing build tool: $cmd" >&2; exit 1; }
done
[[ "$(uname -m)" == x86_64 ]] || { echo "Only x86_64 build hosts are supported" >&2; exit 1; }
start-cli --version | grep -Eq '(^|[[:space:]])1\.1\.0($|[[:space:]])' || {
  echo "Use the previously checksum-verified Start9 CLI 1.1.0 shim." >&2; exit 1;
}
docker info >/dev/null
python3 ../sdk-patch/prepare.py --output-dir "$here/vendor"
npm ci --ignore-scripts
npm audit
npm run check
npm run build
node --test test.cjs
make -B x86
npm audit
echo "BUILD ONLY. Do not install, publish or connect production state."