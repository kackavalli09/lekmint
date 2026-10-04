# Read-only remaining-image evidence check

Run from the newly reviewed source on the external build workstation:

```bash
python3 ops/startos/package/inspect-image-evidence.py \
  /home/lekmint/lek-mint-image-scan.NbSYGy \
  > /home/lekmint/lek-mint-image-evidence.json
```

This checks the **existing** extracted package. No rebuild is needed to collect
this evidence. Upload the resulting JSON. A nonzero exit or `complete: false`
means the check is incomplete; retain errors rather than accepting absence.
Missing host `readelf` is explicitly reported and leaves linkage unverified.
The script requires Python 3.9+.

The script reads selected package versions, module/tool paths, executable mode
bits, ELF class, selected ELF dependencies through the host's readelf, and a
sanitized count of relevant fstab options. It does not execute extracted
programs, run ldd, read secrets, inspect PGDATA, connect to Docker or a database,
or modify the extracted images. Redirecting stdout creates only the report.
Use the trusted extraction, not an actively changing directory.

Its dependency list is scoped to selected tools/libraries, not a complete
transitive call graph. Symlinked directories are not followed. Library presence
does not prove vulnerable-function reachability, and absent package entries do
not prove absence of manually installed software.

Actual Start9 kernel, capabilities, live mount permissions and effective
PostgreSQL authentication/role configuration require a separately authorized
isolated runtime check. Do not send HBA files, service files, environment files,
connection strings or production data.

## PCRE2 source change

Both final runtime Dockerfiles now run the shared Bookworm-only updater. It:

- Uses the image's configured, signature-verified apt repositories.
- Fails on any repository refresh error.
- Upgrades only the already-installed libpcre2-8-0 package (plus any necessary
  dependency resolution), not a distribution-wide upgrade.
- Refuses a resulting version below 10.42-1+deb12u2.
- Prints before/after revisions for the build log and removes apt index caches.

The change is prepared in source; it has **not** changed the already-built
package. No Docker build or repository-resolution test was possible here.
When the remaining review is ready, rebuild externally once, retain the log
and fresh package hash, and scan the actual newly embedded filesystems with a
fresh scanner database. The old package checksum does not cover this change.