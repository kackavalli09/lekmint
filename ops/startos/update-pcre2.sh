#!/bin/sh
# External Docker build only. Never run this against the Start9 host.
set -eu
. /etc/os-release
test "$ID" = debian
test "$VERSION_CODENAME" = bookworm
minimum=10.42-1+deb12u2
package=libpcre2-8-0
test "$(dpkg-query -W -f='${Status}' "$package")" = "install ok installed"
before=$(dpkg-query -W -f='${Version}' "$package")
# Fail on any repository update error; retain normal signature verification.
apt-get -o APT::Update::Error-Mode=any update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  --only-upgrade "$package"
after=$(dpkg-query -W -f='${Version}' "$package")
dpkg --compare-versions "$after" ge "$minimum"
printf 'PCRE2 security update: %s -> %s (minimum %s)\n' "$before" "$after" "$minimum"
rm -rf /var/lib/apt/lists/*