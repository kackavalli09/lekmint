#!/usr/bin/env python3
"""Read-only metadata inspection. Never executes an extracted program.

Usage: python3 inspect-image-evidence.py SCAN_DIRECTORY > image-evidence.json
Requires api-rootfs and postgres-rootfs from scan-built-package.sh.
Does not inspect live volumes, secrets, HBA contents or the host's mount state.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess

PREFIXES = ("perl", "libperl", "libio-compress", "libpcre", "libxml", "python",
            "libsqlite", "sqlite", "libldap", "systemd", "libsystemd", "libudev",
            "util-linux", "mount", "bsdutils", "libacl", "gzip", "ncurses", "libtinfo")
MODULES = ("Archive/Tar.pm", "File/GlobMapper.pm", "Storable.pm", "libxml2.py")
TOOLS = ("perl", "postgres", "pg_config", "mount", "nsenter", "infocmp",
         "gzip", "setfacl", "systemd-homed", "sqlite3", "openssl")


def contained_file(root, path):
    """Refuse symlinks escaping the extraction, including absolute image links."""
    resolved = path.resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("path resolves outside extracted root: " + str(path.relative_to(root)))
    if not resolved.is_file():
        raise ValueError("not a regular file: " + str(path.relative_to(root)))
    return resolved


def packages(root):
    status = contained_file(root, root / "var/lib/dpkg/status")
    result = []
    for stanza in status.read_text().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in stanza.splitlines()
                      if ": " in line and not line.startswith(" "))
        name = fields.get("Package", "")
        if name.startswith(PREFIXES) and fields.get("Status") == "install ok installed":
            result.append({key: fields.get(key) for key in
                           ("Package", "Version", "Architecture", "Depends")})
    return result


def inspect(root, readelf):
    root = root.resolve(strict=True)
    result = {"packages": packages(root), "components": [], "errors": [],
              "dynamic_metadata": [],
              "dynamic_scope": "selected tools and sqlite/xml/ldap/pcre libraries only",
              "readelf_available": bool(readelf)}
    # Traverse only immutable tool/library locations, never /run, /var/lib/postgresql,
    # home directories, configuration mounts, or linked directories.
    for top in ("usr", "bin", "sbin", "lib", "lib64"):
        start = root / top
        if start.is_symlink() or not start.is_dir():
            continue
        def walk_error(error):
            raise error
        for directory, _, files in os.walk(start, followlinks=False, onerror=walk_error):
            for name in files:
                path = Path(directory) / name
                relative = path.relative_to(root).as_posix()
                is_module = any(relative.endswith("/" + suffix) for suffix in MODULES)
                selected = is_module or name in TOOLS or name.startswith(
                    ("libsqlite3.so", "libxml2.so", "libldap", "libpcre2", "libperl", "_libxml2"))
                if not selected:
                    continue
                try:
                    file = contained_file(root, path)
                    with file.open("rb") as stream:
                        header = stream.read(5)
                    elf = header[:4] == b"\x7fELF"
                    result["components"].append({
                        "path": relative, "mode": oct(stat.S_IMODE(file.stat().st_mode)),
                        "elf_class": {1: 32, 2: 64}.get(header[4]) if elf and len(header) == 5 else None,
                    })
                    if elf and readelf:
                        proc = subprocess.run([readelf, "-d", str(file)],
                                              capture_output=True, text=True, timeout=10)
                        if proc.returncode:
                            result["errors"].append({"path": relative, "error": "host readelf failed"})
                        else:
                            result["dynamic_metadata"].append({
                                "path": relative,
                                "needed": re.findall(r"\(NEEDED\).*?\[(.*?)\]", proc.stdout),
                            })
                except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                    result["errors"].append({"path": relative, "error": type(error).__name__})
    # Summarize only known risk flags; never print mount sources, targets or secrets.
    fstab = root / "etc/fstab"
    summary = {"present": fstab.exists() or fstab.is_symlink(), "entries": 0,
               "risk_option_counts": {}}
    if summary["present"]:
        for line in contained_file(root, fstab).read_text().splitlines():
            fields = line.split("#", 1)[0].split()
            if not fields:
                continue
            if len(fields) < 4:
                raise ValueError("malformed fstab; cannot classify")
            summary["entries"] += 1
            for option in fields[3].split(","):
                key = option.split("=", 1)[0]
                if key in ("user", "users", "bind", "rbind", "suid",
                           "X-mount.owner", "X-mount.group", "X-mount.mode",
                           "X-mount.subdir", "X-mount.idmap"):
                    summary["risk_option_counts"][key] = summary["risk_option_counts"].get(key, 0) + 1
    result["fstab"] = summary
    result["complete"] = not result["errors"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scan_directory", type=Path)
    args = parser.parse_args()
    readelf = shutil.which("readelf")  # Host tool only; never search extracted PATH.
    report = {"scope": "extracted image metadata; not device runtime or security clearance",
              "images": {}}
    for image in ("api", "postgres"):
        report["images"][image] = inspect(args.scan_directory / f"{image}-rootfs", readelf)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if all(r["complete"] for r in report["images"].values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())