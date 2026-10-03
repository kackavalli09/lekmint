#!/usr/bin/env python3
"""Repack verified public npm archives; never touches a mint, key, or node_modules."""
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

VERSION = "2.0.9-lek.1"
PACKAGES = {
    "sdk": ("@start9labs/start-sdk", "2.0.9",
            "https://registry.npmjs.org/@start9labs/start-sdk/-/start-sdk-2.0.9.tgz",
            "HuSYrS10Bb+f6OyAMlCzd5Qyr+rIauiI0dF8MVh5Ny+eU0gF8/DeFAXlHFgL+9wkSv4UAP5q5yOzlBpXzsNbWQ=="),
    "brace1": ("brace-expansion", "1.1.21",
               "https://registry.npmjs.org/brace-expansion/-/brace-expansion-1.1.21.tgz",
               "9zeA+KLZNNzglF2TPKRQEDyx6Yby7daAkuy8MiPzpXPsYDWi/DRM8jmwUDxokQjYqBpv5DgPiwD4h4ZZSy1Ujw=="),
    "brace5": ("brace-expansion", "5.0.12",
               "https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.12.tgz",
               "YovQ3rzhaLMIrDjNDMkNS01tea93qhEhG5xy8f6+R0l+dw3Ki+5sCoIoI942iuLZTHWogWktgwVDhU09iNEimQ=="),
    "yaml": ("js-yaml", "4.3.2",
             "https://registry.npmjs.org/js-yaml/-/js-yaml-4.3.2.tgz",
             "SFNOvSJ+Dgf/9An904Yx+CgSlIPCkIpao4qo51lpee25TIRejdH3rhR4EZMGoNx3/TP3O+wzWuiTFl4sqbltzA=="),
}
TARGETS = [
    ("@eslint/config-array/node_modules/brace-expansion", "1.1.15", "brace1"),
    ("@eslint/eslintrc/node_modules/brace-expansion", "1.1.15", "brace1"),
    ("eslint/node_modules/brace-expansion", "1.1.15", "brace1"),
    ("@typescript-eslint/typescript-estree/node_modules/brace-expansion", "5.0.6", "brace5"),
    ("@eslint/eslintrc/node_modules/js-yaml", "4.2.0", "yaml"),
]


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def verify(blob, integrity):
    if base64.b64encode(hashlib.sha512(blob).digest()).decode() != integrity:
        raise ValueError("Archive integrity mismatch; refusing to continue")


def unpack(blob):
    """Read into memory, never extract attacker-controlled paths onto disk."""
    files = {}
    seen = set()
    total = 0
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for entry in archive:
            parts = PurePosixPath(entry.name).parts
            if (not parts or parts[0] != "package" or ".." in parts
                    or entry.name.startswith("/") or "\\" in entry.name):
                raise ValueError("Unsafe archive path")
            path = "/".join(parts)
            if path in seen:
                raise ValueError("Duplicate archive path")
            seen.add(path)
            if entry.isdir():
                continue
            if not entry.isfile():
                raise ValueError("Links and special files are not allowed")
            total += entry.size
            if total > 100_000_000 or len(seen) > 20000:
                raise ValueError("Archive exceeds size limit")
            files[path] = (archive.extractfile(entry).read(), entry.mode & 0o777)
    return files


def pack(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for path, (content, mode) in sorted(files.items()):
                entry = tarfile.TarInfo(path)
                entry.size = len(content)
                entry.mode = mode
                entry.mtime = entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                archive.addfile(entry, io.BytesIO(content))
    return output.getvalue()


def metadata(files, prefix="package"):
    return json.loads(files[prefix + "/package.json"][0])


def patch(archives):
    for key, (name, version, _, _) in PACKAGES.items():
        meta = metadata(archives[key])
        if (meta["name"], meta["version"]) != (name, version):
            raise ValueError("Unexpected package identity")
    result = dict(archives["sdk"])
    expected = {"package/node_modules/" + p + "/package.json" for p, _, _ in TARGETS}
    found = {p for p, (b, _) in result.items() if p.endswith("/package.json")
             and json.loads(b).get("name") in ("brace-expansion", "js-yaml")}
    if found != expected:
        raise ValueError("Bundled dependency layout changed; review required")
    for path, old_version, key in TARGETS:
        prefix = "package/node_modules/" + path
        old = metadata(result, prefix)
        new = metadata(archives[key])
        if old["version"] != old_version or old["name"] != new["name"]:
            raise ValueError("Unexpected bundled version")
        if old.get("dependencies", {}) != new.get("dependencies", {}):
            raise ValueError("Replacement dependency requirements changed")
        for existing in list(result):
            if existing.startswith(prefix + "/"):
                del result[existing]
        for source, value in archives[key].items():
            result[prefix + source[len("package"):]] = value
    meta = metadata(result)
    meta["version"] = VERSION
    result["package/package.json"] = (encode(meta), result["package/package.json"][1])
    result["package/LEK-PATCH-PROVENANCE.json"] = (encode({
        "notice": "Unofficial dependency-only repack; not an upstream Start9 release.",
        "upstreamVersion": "2.0.9", "patchedVersion": VERSION,
        "inputs": {k: {"url": v[2], "integrity": "sha512-" + v[3]} for k, v in PACKAGES.items()},
        "replacements": [{"path": p, "from": old, "to": PACKAGES[k][1]}
                         for p, old, k in TARGETS],
    }), 0o644)
    # Prove every file outside the five replaced subtrees and root metadata survived.
    for path, value in archives["sdk"].items():
        replaced = any(path.startswith("package/node_modules/" + p + "/") for p, _, _ in TARGETS)
        if not replaced and path != "package/package.json" and result.get(path) != value:
            raise ValueError("Unrelated SDK content changed")
    return result


def write_once(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("Output exists with different contents; refusing to overwrite")
        return
    with path.open("xb") as stream:
        stream.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    archives = {}
    for key, (_, version, url, integrity) in PACKAGES.items():
        with urllib.request.urlopen(url, timeout=60) as response:
            if not response.url.startswith("https://registry.npmjs.org/"):
                raise ValueError("Unexpected download origin")
            blob = response.read(20_000_001)
        if len(blob) > 20_000_000:
            raise ValueError("Download too large")
        verify(blob, integrity)
        archives[key] = unpack(blob)
        print(f"Verified {key} {version}")
    content = pack(patch(archives))
    # Re-open the actual output, not just the in-memory input tree.
    check = unpack(content)
    for path, _, key in TARGETS:
        if metadata(check, "package/node_modules/" + path)["version"] != PACKAGES[key][1]:
            raise ValueError("Output verification failed")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    name = f"start9labs-start-sdk-{VERSION}.tgz"
    digest = hashlib.sha256(content).hexdigest()
    write_once(args.output_dir / name, content)
    write_once(args.output_dir / (name + ".sha256"), f"{digest}  {name}\n".encode())
    print(f"Created {args.output_dir / name}\nSHA256 {digest}")
    print("All five replacements verified. Full installed-tree audit and rebuild still required.")


if __name__ == "__main__":
    main()