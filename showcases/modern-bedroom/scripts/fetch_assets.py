#!/usr/bin/env python3
"""Install the pinned modern-bedroom runtime assets listed in assets.lock.json.

The lock pins the runtime bundle (optimized GLB, KTX2 lightmaps, samples sidecars, probes) and the
release download artifacts (source ZIP, portable GLB, Blender master). Only the runtime bundle is
installed into public/; downloads are verified only on request.


If every locked file already exists in public/ with the exact size and SHA-256,
nothing is downloaded. Otherwise the pinned release bundle is streamed to a
temporary file, authenticated, verified entry by entry, and only then are the
files moved into public/. Validation, download and hash failures leave existing
assets untouched; an OS error during the final moves can leave a partial install.

Usage: python3 scripts/fetch_assets.py [--bundle LOCAL.zip] [--check-downloads]
  --bundle LOCAL.zip   install from a local bundle (still verified against the lock) instead of downloading
  --check-downloads    also stream every lock download and verify its size and SHA-256
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "assets.lock.json"
PUBLIC = ROOT / "public"
CHUNK = 1 << 20
TIMEOUT = 60
USER_AGENT = "img2interior-modern-bedroom-fetch-assets/1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class FetchError(Exception):
    pass


def _check_digest(value, label):
    if not isinstance(value, str) or not SHA256_RE.match(value):
        raise FetchError(f"{label}: sha256 must be 64 lowercase hex characters")


def _check_bytes(value, label):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise FetchError(f"{label}: bytes must be a non-negative integer")


def safe_relative_path(name, label):
    """Return the parts of a safe 'assets/...' POSIX relative path."""
    if not isinstance(name, str) or not name:
        raise FetchError(f"{label}: path must be a non-empty string")
    if "\\" in name or "\x00" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise FetchError(f"{label}: unsafe path {name!r}")
    parts = PurePosixPath(name).parts
    if "/".join(parts) != name or len(parts) < 2 or parts[0] != "assets" or any(p in ("", ".", "..") for p in parts):
        raise FetchError(f"{label}: unsafe path {name!r}")
    return parts


def load_lock(path):
    try:
        lock = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise FetchError(f"cannot read lock file {path}: {error}")
    if not isinstance(lock, dict) or lock.get("schemaVersion") != 1:
        raise FetchError("lock file: schemaVersion must be 1")
    pending = lock.get("status") == "pending"
    if pending and not (isinstance(lock.get("bundle"), dict) and lock["bundle"].get("sha256")):
        raise FetchError("assets.lock.json is pending: the release assets are not published/locked yet. Run scripts/lock_assets.py against the final public/ directory first")
    bundle = lock.get("bundle")
    if not isinstance(bundle, dict):
        raise FetchError("lock file: bundle is missing")
    url = bundle.get("url")
    parsed = urlparse(url) if isinstance(url, str) else None
    if parsed is None or parsed.scheme != "https" or not parsed.netloc:
        raise FetchError("lock file: bundle.url must be an https URL")
    _check_digest(bundle.get("sha256"), "bundle")
    _check_bytes(bundle.get("bytes"), "bundle")
    files = lock.get("files")
    if not isinstance(files, list) or not files:
        raise FetchError("lock file: files must be a non-empty list")
    seen = set()
    for entry in files:
        if not isinstance(entry, dict):
            raise FetchError("lock file: each file entry must be an object")
        name = entry.get("path")
        safe_relative_path(name, "lock file")
        if name in seen:
            raise FetchError(f"lock file: duplicate path {name}")
        seen.add(name)
        _check_digest(entry.get("sha256"), name)
        _check_bytes(entry.get("bytes"), name)
    downloads = lock.get("downloads", {})
    if not isinstance(downloads, dict):
        raise FetchError("lock file: downloads must be an object")
    for key, item in downloads.items():
        if not isinstance(item, dict):
            raise FetchError(f"lock file: downloads.{key} must be an object")
        parsed = urlparse(item.get("url")) if isinstance(item.get("url"), str) else None
        if parsed is None or parsed.scheme != "https" or not parsed.netloc:
            raise FetchError(f"downloads.{key}: url must be an https URL")
        if "sha256" not in item and (pending or key == "source"):
            continue  # not hashed yet (pending) or the source ZIP, which cannot contain its own hash; --check-downloads rejects it
        _check_digest(item.get("sha256"), f"downloads.{key}")
        _check_bytes(item.get("bytes"), f"downloads.{key}")
    return lock


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as reader:
        for block in iter(lambda: reader.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def target_path(root, name):
    root = Path(root)
    path = root
    for part in PurePosixPath(name).parts[:-1]:
        path = path / part
        if path.is_symlink():
            raise FetchError(f"{path} is a symlink; refusing to write assets through it")
    return root.joinpath(*PurePosixPath(name).parts)


def assets_current(lock, root):
    for entry in lock["files"]:
        path = target_path(root, entry["path"])
        if path.is_symlink() or not path.is_file() or path.stat().st_size != entry["bytes"]:
            return False
        if sha256_of(path) != entry["sha256"]:
            return False
    return True


def download_bundle(bundle, destination):
    """Stream the bundle to destination, requiring the pinned size and SHA-256."""
    request = urllib.request.Request(bundle["url"], headers={"User-Agent": USER_AGENT})
    digest = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response, open(destination, "wb") as writer:
            while True:
                block = response.read(CHUNK)
                if not block:
                    break
                total += len(block)
                if total > bundle["bytes"]:
                    raise FetchError(f"bundle is larger than the pinned {bundle['bytes']} bytes")
                digest.update(block)
                writer.write(block)
    except (urllib.error.URLError, OSError) as error:
        raise FetchError(f"download of {bundle['url']} failed: {error}")
    if total != bundle["bytes"]:
        raise FetchError(f"bundle has {total} bytes, expected {bundle['bytes']}")
    if digest.hexdigest() != bundle["sha256"]:
        raise FetchError("bundle SHA-256 does not match the lock file")


def verify_inventory(archive, lock):
    infos = archive.infolist()
    names = [info.filename for info in infos]
    if len(set(names)) != len(names):
        raise FetchError("bundle contains duplicate entries")
    for info in infos:
        safe_relative_path(info.filename, "bundle")
        unix_type = stat.S_IFMT(info.external_attr >> 16)
        if info.is_dir() or unix_type not in (0, stat.S_IFREG):
            raise FetchError(f"bundle entry {info.filename} is not a regular file")
    expected = {entry["path"] for entry in lock["files"]}
    if set(names) != expected:
        extra = sorted(set(names) - expected)
        missing = sorted(expected - set(names))
        raise FetchError(f"bundle entries differ from lock (unexpected: {extra}, missing: {missing})")


def extract_verified(archive, entry, destination):
    digest = hashlib.sha256()
    total = 0
    with archive.open(entry["path"]) as reader, open(destination, "wb") as writer:
        while True:
            block = reader.read(CHUNK)
            if not block:
                break
            total += len(block)
            if total > entry["bytes"]:
                raise FetchError(f"{entry['path']} is larger than the pinned {entry['bytes']} bytes")
            digest.update(block)
            writer.write(block)
    if total != entry["bytes"]:
        raise FetchError(f"{entry['path']} has {total} bytes, expected {entry['bytes']}")
    if digest.hexdigest() != entry["sha256"]:
        raise FetchError(f"{entry['path']} SHA-256 does not match the lock file")


def install_from_bundle(lock, root, bundle_path, staging):
    """Verify bundle_path completely inside staging, then move files into root."""
    try:
        archive = zipfile.ZipFile(bundle_path)
    except (zipfile.BadZipFile, OSError) as error:
        raise FetchError(f"bundle is not a readable ZIP: {error}")
    staged = []
    with archive:
        verify_inventory(archive, lock)
        for index, entry in enumerate(lock["files"]):
            destination = Path(staging) / f"entry-{index}"
            try:
                extract_verified(archive, entry, destination)
            except (zipfile.BadZipFile, OSError, RuntimeError) as error:
                raise FetchError(f"cannot extract {entry['path']}: {error}")
            staged.append((destination, target_path(root, entry["path"])))
    for source, target in staged:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)


def check_file(path, item, label):
    path = Path(path)
    if not path.is_file() or path.stat().st_size != item["bytes"] or sha256_of(path) != item["sha256"]:
        raise FetchError(f"{label} does not match the lock (size/SHA-256)")


def check_downloads(lock):
    """Stream every locked release download and require its pinned size and SHA-256."""
    for key, item in sorted(lock.get("downloads", {}).items()):
        if "sha256" not in item:
            if key == "source":
                print("fetch_assets: download source skipped (the archived lock cannot pin its own ZIP)")
                continue
            raise FetchError(f"downloads.{key} is not hashed in the lock yet (pending); run lock_assets.py --download {key}=PATH")
        with tempfile.TemporaryDirectory(prefix=".fetch-assets-") as staging:
            target = Path(staging) / key
            download_bundle(item, target)  # same size + SHA-256 enforcement as the bundle
        print(f"fetch_assets: download {key} verified ({item['bytes']:,} bytes)")


def fetch(lock, root, local_bundle=None):
    """Ensure all locked assets are present under root. Returns True if installed."""
    root = Path(root)
    if assets_current(lock, root):
        return False
    root.mkdir(parents=True, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".fetch-assets-", dir=root)
    try:
        bundle_path = Path(staging) / "bundle.zip"
        if local_bundle is not None:
            check_file(local_bundle, lock["bundle"], f"local bundle {local_bundle}")
            shutil.copyfile(local_bundle, bundle_path)
        else:
            download_bundle(lock["bundle"], bundle_path)
        install_from_bundle(lock, root, bundle_path, staging)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return True


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Install the pinned modern-bedroom runtime assets.")
    parser.add_argument("--bundle", type=Path, help="local bundle ZIP to install instead of downloading")
    parser.add_argument("--check-downloads", action="store_true", help="also verify the release download artifacts")
    args = parser.parse_args()
    try:
        lock = load_lock(LOCK)
        if args.check_downloads:
            check_downloads(lock)
        if fetch(lock, PUBLIC, args.bundle):
            print(f"fetch_assets: installed {len(lock['files'])} verified assets into {PUBLIC}")
        else:
            print("fetch_assets: assets already present and verified")
    except FetchError as error:
        sys.exit(f"fetch_assets: {error}\nNo existing asset was modified by a failed download or validation; check the network and the release, then retry.")
    except OSError as error:
        sys.exit(f"fetch_assets: install failed: {error}\nSome assets may have been replaced; fix the filesystem problem and rerun to verify and complete the install.")


if __name__ == "__main__":
    main()
