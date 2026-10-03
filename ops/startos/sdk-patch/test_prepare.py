import importlib.util
import io
import tarfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("prepare", Path(__file__).with_name("prepare.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PatchTests(unittest.TestCase):
    def test_deterministic_roundtrip(self):
        files = {"package/z": (b"last", 0o755), "package/a": (b"first", 0o644)}
        self.assertEqual(p.pack(files), p.pack(dict(reversed(list(files.items())))))
        self.assertEqual(p.unpack(p.pack(files)), files)

    def test_integrity_failure(self):
        with self.assertRaises(ValueError):
            p.verify(b"altered", p.PACKAGES["sdk"][3])

    def test_unsafe_archives(self):
        for name, kind in [("package/../escape", tarfile.REGTYPE),
                           ("/absolute", tarfile.REGTYPE),
                           ("package/link", tarfile.SYMTYPE)]:
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode="w:gz") as archive:
                item = tarfile.TarInfo(name)
                item.type = kind
                archive.addfile(item)
            with self.assertRaises(ValueError):
                p.unpack(data.getvalue())

    def fixtures(self):
        archives = {}
        for key, (name, version, _, _) in p.PACKAGES.items():
            archives[key] = {"package/package.json": (
                p.encode({"name": name, "version": version, "dependencies": {}}), 0o644)}
        for path, old, key in p.TARGETS:
            archives["sdk"]["package/node_modules/" + path + "/package.json"] = (
                p.encode({"name": p.PACKAGES[key][0], "version": old, "dependencies": {}}), 0o644)
        archives["sdk"]["package/core.js"] = (b"preserve me", 0o755)
        return archives

    def test_five_replacements_and_preserved_source(self):
        source = self.fixtures()
        result = p.patch(source)
        self.assertEqual(result["package/core.js"], source["sdk"]["package/core.js"])
        for path, _, key in p.TARGETS:
            self.assertEqual(p.metadata(result, "package/node_modules/" + path)["version"],
                             p.PACKAGES[key][1])
        self.assertEqual(p.metadata(result)["version"], p.VERSION)

    def test_changed_layout_refused(self):
        source = self.fixtures()
        del source["sdk"]["package/node_modules/" + p.TARGETS[0][0] + "/package.json"]
        with self.assertRaises(ValueError):
            p.patch(source)

    def test_changed_dependency_requirements_refused(self):
        source = self.fixtures()
        meta = p.metadata(source["brace1"])
        meta["dependencies"] = {"new-dependency": "*"}
        source["brace1"]["package/package.json"] = (p.encode(meta), 0o644)
        with self.assertRaises(ValueError):
            p.patch(source)


if __name__ == "__main__":
    unittest.main()