# Remaining OS findings — review, not installation approval

## Scope and result

Reviewed the rebuilt API and PostgreSQL JSON inventories, operator-provided
component checks, current Debian tracker entries for **all 32 distinct critical
or high OS advisories**, selected upstream advisories, and the current API,
database, startup, package-daemon and backup/restore source.

The reports contain 19 critical and 134 high OS package/advisory occurrences.
Those raw counts remain unchanged. Deduplication is not remediation.

**One concrete additional package update is recommended:** update
`libpcre2-8-0` in both runtime images from `10.42-1+deb12u1` to Debian's fixed
`10.42-1+deb12u2` or a later compatible Bookworm security version. The current
Debian tracker and DLA-4816-1 list this fix even though the supplied scanner
snapshot has an empty fixed-version field.

No Dockerfiles, dependencies, application behavior, SQL schema, or device state
were changed in this review. There is no installation or production approval.
The original broader migration remains incomplete.

Subsequent authorized implementation: the two runtime build recipes now use
the guarded PCRE2 updater. Fixture tests and a read-only evidence collector are
included; see IMAGE-EVIDENCE-CHECK.md. This does not update the scanned package
or close the external build, scan, native linkage or runtime verification gaps.

## Evidence and limits

- Inventory inputs: `0_api-report_1791080660530.json` and
  `1_postgres-report_1791080660542.json` in attached_assets.
- Package checksum, reported base-image identities, prior targeted fixes and
  the operator's ELF/component checks are recorded in SECURITY-REBUILD.md.
- The API uses Node and PostgreSQL through node-postgres/Drizzle. Source searches
  did not identify direct Perl, SQLite, libxml2, PCRE2 JIT, LDAP or DTLS use in
  the API/database code. This is negative source evidence, not a proof covering
  native transitive libraries, every SQL path, or compromised processes.
- Startup starts PostgreSQL and Node, not systemd-homed. The scanned inventories
  contain systemd libraries, not an installed systemd-homed package.
- PostgreSQL is configured to listen on loopback, but imported PGDATA carries
  its own authentication configuration. Neither loopback nor absence of XML
  columns prevents an authenticated SQL user from calling XML functions.
- Backup/restore source uses PostgreSQL custom-format dumps and age, not Perl
  Archive::Tar. These scripts do not establish the safety of every recovery tool
  or audit the separate backup image.
- Actual Start9 capabilities, setuid behavior, namespaces, mount configuration,
  effective database roles/HBA, dynamically loaded libraries and filesystem
  contents beyond the supplied checks remain unverified.

## Disposition by advisory

“No app path found” is **not** “not affected.” It means no ordinary use was
identified in the reviewed source, with the remaining condition stated below.
Debian's “minor issue,” “no-dsa,” or “postponed” annotations are not risk acceptance
for this financial service.

| Advisory | Scope | Disposition and next action |
| --- | --- | --- |
| CVE-2026-103111 | PCRE2, both images | **Update recommended.** Fixed Bookworm package exists. Upstream trigger requires attacker-controlled patterns with JIT and a growable JIT stack. No direct app use found, but a supported security update is preferable to asserting that all native consumers are unreachable. |
| CVE-2023-45853 | zlib, both | **Non-applicability supported for the flagged zlib binaries.** Debian states the affected contrib/minizip code is not built into these Bookworm zlib packages; no standalone minizip package is in the reports. Does not clear arbitrary bundled minizip copies. |
| CVE-2026-8376 | Perl, both | **Non-applicability supported for the checked executables.** Advisory is restricted to 32-bit builds; the operator inspected 64-bit ELF headers in both images. Does not clear other Perl issues or uninspected embedded Perl builds. |
| CVE-2026-13221 | Perl, both | **Unresolved evidence conflict.** Debian marks 5.36 vulnerable; its introduction note points to 5.37.10. The linked upstream issue says 5.36 is unaffected by a regex-debugging reproduction, whereas the security announcement describes a large-alternation truncation issue. Do not assume these are identical triggers. Need exact Debian source/patch analysis or maintainer clarification before an exception. No app-supplied Perl regex path found. |
| CVE-2026-42496 | Archive::Tar symlink extraction | **API component-absence evidence; PostgreSQL open.** Operator found no Archive/Tar.pm in API, but did find it in PostgreSQL. No app/startup/backup invocation found. Avoid untrusted archive extraction through this module; retained PostgreSQL component is not fixed. |
| CVE-2026-42497 | Archive::Tar hardlink extraction | Same component evidence and restrictions as CVE-2026-42496. PostgreSQL remains open; link metadata operations can affect files outside extraction. |
| CVE-2026-9538 | Archive::Tar memory exhaustion | Same component evidence; affected payload is an untrusted archive size field. Upstream fix is 3.10, so upgrading only to 3.08 would not address all three Archive::Tar findings. |
| CVE-2026-48962 | Perl IO::Compress/File::GlobMapper | **Open; no app path found.** Requires an attacker-controlled output glob reaching Perl eval. Debian has a fix for the separate libio-compress-perl source package, but these findings are against bundled Perl packages. Do not claim the bundled copy fixed or install an untested shadowing module. Verify actual module presence and consumers. |
| CVE-2026-57432 | Perl pack/unpack | **Open; no app path found.** Requires untrusted templates and large repeat counts. 64-bit architecture alone is not an exception. Keep external input out of Perl templates; await compatible vendor remediation or validate a targeted backport. |
| CVE-2026-57433 | Perl Storable | **Open; no app path found.** Crafted thaw/retrieve blob can terminate deserialization. Verify module presence; do not deserialize untrusted Perl blobs. |
| CVE-2025-7458 | SQLite, PostgreSQL image | **Open; no app path found.** The ledger is PostgreSQL, not SQLite. This does not prove the installed SQLite library has no consumers. Needs a crafted SQL query reaching SQLite. Trace consumers before removing or accepting the library. |
| CVE-2026-11822 | SQLite FTS5 | **Open; no app path found.** Requires a malicious SQLite database and FTS5 query processing. No such import/use found in app source. Verify other image consumers and FTS5 build configuration. |
| CVE-2026-11824 | SQLite FTS5 | Same unresolved consumer/configuration conditions; memory corruption is not cleared merely because SQLite is not the ledger. |
| CVE-2026-6653 | libxml2, PostgreSQL | **Open, priority review.** PostgreSQL can use libxml2 for SQL XML functions. No app XML use found, but authenticated SQL or other consumers could reach parsing. Debian explicitly identifies a vulnerable backport, so upstream version-range shortcuts are unsafe. Verify linked build, parser behavior and SQL access; do not remove libxml2. |
| CVE-2026-74860 | libxml2 Python SAX bindings | **Conditional component exclusion, not final clearance.** No Python binding package appears in the inventory and no Python service is declared. Verify no manually installed bindings before accepting an image-wide exception. |
| CVE-2026-86138 | libxml2 xmlDictAddQString | **Open.** Integer overflow/heap overwrite; determine PostgreSQL or other native consumer call paths and input constraints. |
| CVE-2026-86139 | libxml2 xmlURIEscapeStr | **Open.** URI escaping overflow; absence of XML app columns is insufficient evidence. |
| CVE-2026-86140 | libxml2 xmlSnprintfElements | **Open.** Stack overflow in element formatting/validation path; determine actual callers. |
| CVE-2026-86142 | libxml2 XPointer | **Open.** XPointer length issue; XML support does not establish that this particular XPointer path is used or unused. |
| CVE-2026-86143 | libxml2 output callbacks | **Open.** Negative lengths can reach callbacks; verify consumer output paths. |
| CVE-2026-86144 | libxml2 XInclude flags | **Open.** Requires XInclude/resource-loading behavior. Do not equate PostgreSQL XPath with XInclude or assume all XML consumers have network access disabled. |
| CVE-2026-84782 | OpenSSL, PostgreSQL image | **Not applicable to the PostgreSQL TCP/TLS protocol path; image-wide disposition conditional.** Upstream issue is specifically DTLS retransmission, not ordinary TLS. No DTLS service found. Confirm no other DTLS consumer before an image-wide exception; do not label OpenSSL itself patched. |
| CVE-2023-2953 | OpenLDAP client library | **Open, configuration-dependent.** PostgreSQL supports LDAP authentication, while effective HBA was not supplied. Check isolated runtime authentication methods and other LDAP consumers. Installed client library is not proof of an LDAP server. |
| CVE-2026-16742 | systemd library package rows, both | **Non-applicability supported for declared service topology.** The advisory concerns homed-managed users and systemd-homed, not merely linking libsystemd. Inventories/daemon declarations do not show that service. Confirm no extra executable/service at runtime before extending this to the whole device. |
| CVE-2026-53613 | util-linux, both | **Open, local privilege condition.** Needs user/users-authorized fstab mount and writable ancestor. Check effective fstab, setuid/capabilities and writable mount paths in isolated runtime. Do not treat repeated library-package rows as separate exploits. |
| CVE-2026-76642 | util-linux mount hooks | **Open, local privilege condition.** Check privileged mount-helper and X-mount hook availability. App source does not invoke them; host/container privilege configuration still matters. |
| CVE-2026-78408 | util-linux nsenter | **Open, operator-action condition.** Requires privileged nsenter --join-cgroup against an attacker-controlled target. No application invocation found. Avoid that diagnostic action; verify option presence in the installed version rather than assuming a source-package row proves it exists. |
| CVE-2026-78409 | util-linux subdirectory mounts | **Open, kernel/configuration-dependent.** Advisory describes Linux 6.15+ fast path and fstab X-mount.subdir authorization. Need actual Start9 kernel and mount configuration; external build-host kernel is not sufficient. |
| CVE-2026-78410 | util-linux restricted bind mounts | **Open, local privilege condition.** Requires replaceable source/ancestor and authorized privileged bind mount; ownership hooks worsen impact. Check configuration, do not assume an unprivileged API alone prevents exploitation after compromise. |
| CVE-2026-54369 | libacl | **Open, privileged filesystem operation condition.** Needs attacker-controlled pathname components processed by privileged ACL callers. No direct app ACL calls found; startup/recovery/host tools need separate review. Debian notes new ABI/backport compatibility problems; do not blindly replace this library. |
| CVE-2026-41992 | gzip | **Open, tool-input condition.** Requires crafted LZW then LZH input in one decompression invocation. Node HTTP decompression is not evidence of invoking GNU gzip. No such runtime flow found; restrict operator decompression to trusted inputs. |
| CVE-2025-69720 | ncurses | **Open, tool-input condition.** Affects infocmp CLI analysis, not every use of terminal libraries. No app invocation found. Check executable presence and avoid untrusted terminal descriptions; library-package repetition does not establish runtime reachability. |

## Proposed remediation and evidence sequence

1. Make a narrowly scoped, reviewed Bookworm security-package update for PCRE2 in
   both final runtime images. Check external repository availability and package
   signatures; use a version floor rather than replacing Bookworm with another
   distribution. Preserve PostgreSQL major 16 and the pinned gosu behavior.
   Record the resulting installed revision and any dependency changes.
2. Before deciding on other package changes, collect one consolidated read-only
   component/configuration inventory from the exact extracted images: suspect
   module/tool presence, ELF dependency metadata, relevant package ownership and
   default fstab. Do not execute extracted programs with ldd or print secrets.
   Runtime-only configuration must later be checked using disposable test data.
3. Prioritize libxml2/SQL access and the Perl advisory conflict. Do not patch
   financial code merely to compensate for unrelated tooling findings. Do not
   delete required libraries or replace Perl wholesale without compatibility
   evidence. No untested CPAN override or blanket ignore file is recommended.
4. Rebuild and scan once the agreed image changes are ready. Refresh the scanner
   database and record its identity; distinguish changes due to a newer advisory
   database from actual package remediation. Preserve the prior package.
5. Separately authorize isolated device startup, privilege, authentication,
   persistence, shutdown, SMTP and transaction/recovery tests. No production
   state, secrets, DNS changes or activation are authorized by this review.

This review does not claim a zero-risk image or complete native call-graph
analysis. Unresolved rows need evidence, a compatible fix, or explicit
documented risk acceptance before being treated as closed.

## Sources

For **every CVE in the table**, its Debian source is
`https://security-tracker.debian.org/tracker/<CVE-ID>`; all 32 were fetched during
this review. Fixed-version status can change after these snapshots.

- [PCRE2 Debian security update](https://security-tracker.debian.org/tracker/DLA-4816-1)
- [PCRE2 upstream affected configurations](https://github.com/PCRE2Project/pcre2/security/advisories/GHSA-r9hj-j2rw-4q3m)
- [Perl security announcement](https://lists.security.metacpan.org/cve-announce/msg/41780104/)
- [Linked Perl issue and narrower reproduction](https://github.com/Perl/perl5/issues/23388)
- [PostgreSQL 16 XML support](https://www.postgresql.org/docs/16/datatype-xml.html)
- [OpenSSL DTLS advisory](https://openssl-library.org/news/secadv/20260929.txt)