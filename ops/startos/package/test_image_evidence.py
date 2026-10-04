"""Fixture-only checks; no Docker, apt repositories, services or real state."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("evidence", HERE / "inspect-image-evidence.py")
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "var/lib/dpkg").mkdir(parents=True)
        (self.root / "var/lib/dpkg/status").write_text(
            "Package: perl-base\nStatus: install ok installed\n"
            "Version: 5.36.0-7+deb12u3\nArchitecture: amd64\n\n")
        (self.root / "usr/bin").mkdir(parents=True)
        (self.root / "etc").mkdir()

    def test_metadata_without_execution(self):
        (self.root / "usr/bin/perl").write_bytes(b"\x7fELF\x02fixture")
        (self.root / "etc/fstab").write_text(
            "SECRET_SOURCE /private/path auto users,X-mount.owner=SECRET_VALUE 0 0\n")
        with patch.object(subprocess, "run", side_effect=AssertionError("must not execute")):
            result = evidence.inspect(self.root, None)
        self.assertEqual(result["components"][0]["elf_class"], 64)
        self.assertEqual(result["fstab"]["risk_option_counts"]["users"], 1)
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertNotIn("/private/path", json.dumps(result))
        self.assertFalse(result["readelf_available"])

    def test_external_symlink_is_not_read(self):
        (self.root / "usr/bin/perl").symlink_to("/etc/passwd")
        result = evidence.inspect(self.root, None)
        self.assertFalse(result["complete"])
        self.assertEqual(result["components"], [])

    def test_missing_inventory_fails(self):
        (self.root / "var/lib/dpkg/status").unlink()
        with self.assertRaises(ValueError):
            evidence.inspect(self.root, None)

    def test_module_and_host_readelf_metadata(self):
        module = self.root / "usr/share/perl/5.36/Archive/Tar.pm"
        module.parent.mkdir(parents=True)
        module.write_text("fixture")
        (self.root / "usr/bin/postgres").write_bytes(b"\x7fELF\x02fixture")
        reply = subprocess.CompletedProcess([], 0, "(NEEDED) Shared library: [libxml2.so.2]", "")
        with patch.object(subprocess, "run", return_value=reply) as run:
            result = evidence.inspect(self.root, "/host/readelf")
        self.assertEqual(run.call_args.args[0][0], "/host/readelf")
        self.assertEqual(result["dynamic_metadata"][0]["needed"], ["libxml2.so.2"])
        self.assertTrue(any(c["path"].endswith("Archive/Tar.pm") for c in result["components"]))

    def test_bad_fstab_fails(self):
        (self.root / "etc/fstab").write_text("malformed\n")
        with self.assertRaises(ValueError):
            evidence.inspect(self.root, None)


class UpdateTests(unittest.TestCase):
    def run_fixture(self, new_version, update_failure="0"):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            release = root / "os-release"
            release.write_text("ID=debian\nVERSION_CODENAME=bookworm\n")
            script = (HERE.parent / "update-pcre2.sh").read_text().replace(
                ". /etc/os-release", f". {release}")
            (root / "update.sh").write_text(script)
            # All mutating commands are fixtures, including rm; no host apt runs.
            stubs = {
                "apt-get": 'echo "$*" >> "$LOG"; case "$*" in *update) exit "$FAIL_UPDATE";; esac',
                "dpkg-query": '''case "$*" in
                  *Status*) printf 'install ok installed';;
                  *) printf '%s' "$NEW_VERSION";;
                esac''',
                "dpkg": '''test "$1" = --compare-versions
                    test "$2" = 10.42-1+deb12u2 && test "$3" = ge && test "$4" = 10.42-1+deb12u2''',
                "rm": 'echo cleanup >> "$LOG"',
            }
            for name, content in stubs.items():
                path = root / name
                path.write_text("#!/bin/sh\nset -eu\n" + content + "\n")
                path.chmod(0o755)
            log = root / "log"
            env = dict(os.environ, PATH=str(root), LOG=str(log),
                       NEW_VERSION=new_version, FAIL_UPDATE=update_failure)
            result = subprocess.run(["/bin/sh", str(root / "update.sh")],
                                    env=env, capture_output=True, text=True)
            return result, log.read_text()

    def test_update_success(self):
        result, log = self.run_fixture("10.42-1+deb12u2")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--only-upgrade libpcre2-8-0", log)
        self.assertIn("cleanup", log)

    def test_old_version_refuses(self):
        result, log = self.run_fixture("10.42-1+deb12u1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("cleanup", log)

    def test_repository_error_refuses(self):
        result, log = self.run_fixture("10.42-1+deb12u2", "1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("--only-upgrade", log)

    def test_both_final_images_use_guard(self):
        for name, marker in (("api", "FROM ${NODE_IMAGE} AS runtime"),
                             ("postgres", "FROM ${POSTGRES_IMAGE}")):
            text = (HERE.parent / f"Dockerfile.{name}").read_text()
            final = text.split(marker, 1)[1]
            self.assertIn("sh /tmp/lek-update-pcre2.sh", final)
        text = (HERE.parent / "update-pcre2.sh").read_text()
        self.assertNotIn("--allow-unauthenticated", text)
        self.assertNotIn("apt-get upgrade", text)


if __name__ == "__main__":
    unittest.main()