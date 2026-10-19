import hashlib
import importlib.util
import io
import json
import stat
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "fetch_assets.py"
spec = importlib.util.spec_from_file_location("fetch_assets", SCRIPT)
fa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fa)

FILES = {
    "assets/interior/a.bin": b"alpha",
    "assets/b.bin": b"bravo-bytes",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_zip(path, members):
    """members: list of (name, bytes, optional external_attr)."""
    with zipfile.ZipFile(path, "w") as archive:
        for member in members:
            info = zipfile.ZipInfo(member[0])
            if len(member) > 2:
                info.external_attr = member[2]
            archive.writestr(info, member[1])


def make_lock(bundle_path, files=FILES):
    raw = Path(bundle_path).read_bytes()
    return {
        "schemaVersion": 1,
        "bundle": {"url": "https://example.invalid/b.zip", "sha256": sha(raw), "bytes": len(raw)},
        "files": [{"path": n, "sha256": sha(d), "bytes": len(d)} for n, d in files.items()],
    }


class FetchAssetsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.root = self.dir / "public"
        self.bundle = self.dir / "bundle.zip"

    def serve_bundle(self):
        """Patch urlopen to serve the fixture bundle; production download_bundle runs for real."""
        patcher = mock.patch("urllib.request.urlopen", side_effect=lambda *a, **k: io.BytesIO(self.bundle.read_bytes()))
        self.urlopen = patcher.start()
        self.addCleanup(patcher.stop)

    def leftovers(self):
        return [p.name for p in self.root.iterdir() if p.name.startswith(".fetch-assets-")]

    def test_valid_install_writes_exact_files_and_cleans_up(self):
        make_zip(self.bundle, [(n, d) for n, d in FILES.items()])
        lock = make_lock(self.bundle)
        self.serve_bundle()
        self.assertTrue(fa.fetch(lock, self.root))
        for name, data in FILES.items():
            self.assertEqual((self.root / name).read_bytes(), data)
        self.assertEqual(self.leftovers(), [])

    def test_existing_exact_assets_avoid_network(self):
        make_zip(self.bundle, [(n, d) for n, d in FILES.items()])
        lock = make_lock(self.bundle)
        for name, data in FILES.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network used")) as urlopen:
            self.assertFalse(fa.fetch(lock, self.root))
        urlopen.assert_not_called()

    def assert_failure_preserves_existing(self, lock, message=None):
        self.serve_bundle()
        stale = self.root / "assets" / "b.bin"
        stale.parent.mkdir(parents=True, exist_ok=True)
        stale.write_bytes(b"stale")
        with self.assertRaises(fa.FetchError) as ctx:
            fa.fetch(lock, self.root)
        if message:
            self.assertIn(message, str(ctx.exception))
        self.assertEqual(stale.read_bytes(), b"stale")
        self.assertFalse((self.root / "assets" / "interior" / "a.bin").exists())
        self.assertEqual(self.leftovers(), [])

    def test_corrupt_bundle_hash_is_rejected(self):
        make_zip(self.bundle, [(n, d) for n, d in FILES.items()])
        lock = make_lock(self.bundle)
        lock["bundle"]["sha256"] = "0" * 64
        self.assert_failure_preserves_existing(lock, "bundle SHA-256")

    def test_corrupt_entry_content_is_rejected(self):
        make_zip(self.bundle, [("assets/interior/a.bin", b"alpha"), ("assets/b.bin", b"BRAVO-bytes")])
        self.assert_failure_preserves_existing(make_lock(self.bundle), "assets/b.bin")

    def test_unexpected_and_missing_entries_are_rejected(self):
        make_zip(self.bundle, [("assets/interior/a.bin", b"alpha"), ("assets/extra.bin", b"x")])
        self.assert_failure_preserves_existing(make_lock(self.bundle), "differ from lock")

    def test_unsafe_entry_paths_are_rejected(self):
        for bad in ("assets/../evil.bin", "/assets/b.bin", "assets\\b.bin", "assets/./b.bin"):
            with self.subTest(bad=bad):
                make_zip(self.bundle, [("assets/interior/a.bin", b"alpha"), (bad, b"x")])
                self.assert_failure_preserves_existing(make_lock(self.bundle), "unsafe path")

    def test_duplicate_entries_are_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            make_zip(self.bundle, [("assets/interior/a.bin", b"alpha"), ("assets/b.bin", b"bravo-bytes"),
                                   ("assets/b.bin", b"bravo-bytes")])
        self.assert_failure_preserves_existing(make_lock(self.bundle), "duplicate")

    def test_symlink_and_other_special_entries_are_rejected(self):
        for kind in (stat.S_IFLNK, stat.S_IFCHR, stat.S_IFIFO):
            with self.subTest(kind=kind):
                attr = (kind | 0o777) << 16
                make_zip(self.bundle, [("assets/interior/a.bin", b"alpha"), ("assets/b.bin", b"bravo-bytes", attr)])
                self.assert_failure_preserves_existing(make_lock(self.bundle), "not a regular file")

    def test_symlinked_ancestor_is_not_written_through(self):
        make_zip(self.bundle, [(n, d) for n, d in FILES.items()])
        lock = make_lock(self.bundle)
        outside = self.dir / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_bytes(b"keep")
        (self.root / "assets").mkdir(parents=True)
        (self.root / "assets" / "interior").symlink_to(outside, target_is_directory=True)
        self.serve_bundle()
        with self.assertRaises(fa.FetchError):
            fa.fetch(lock, self.root)
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel.txt"])
        self.assertEqual(sentinel.read_bytes(), b"keep")

    def test_lock_validation_rejects_bad_schema(self):
        make_zip(self.bundle, [(n, d) for n, d in FILES.items()])
        good = make_lock(self.bundle)
        cases = {
            "http": lambda l: l["bundle"].update(url="http://example.invalid/b.zip"),
            "traversal": lambda l: l["files"][0].update(path="assets/../x"),
            "dot alias": lambda l: l["files"][0].update(path="assets/./x"),
            "duplicate": lambda l: l["files"].append(dict(l["files"][0])),
            "digest": lambda l: l["files"][0].update(sha256="ABC"),
            "length": lambda l: l["files"][0].update(bytes=-1),
        }
        for label, mutate in cases.items():
            with self.subTest(label):
                lock = json.loads(json.dumps(good))
                mutate(lock)
                path = self.dir / "lock.json"
                path.write_text(json.dumps(lock), encoding="utf-8")
                with self.assertRaises(fa.FetchError):
                    fa.load_lock(path)


if __name__ == "__main__":
    unittest.main()
