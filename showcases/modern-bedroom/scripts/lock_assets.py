#!/usr/bin/env python3
"""Pin the final modern-bedroom assets: build the runtime bundle ZIP and rewrite assets.lock.json.

Reads the finished runtime set from --public-dir (default public/), i.e.
  assets/interior-runtime/**   optimized GLB (meshopt + KTX2), KTX2 lightmaps, lightmap-samples.bin/.json,
                               Radiance probe/sky, manifest.json, optimized.json
  assets/reference.png         design reference image
and writes
  --output-bundle              deterministic ZIP of exactly those files (default .release/modern-bedroom-assets.zip)
  --lock                       assets.lock.json: bundle url/sha256/bytes, per-file sha256/bytes, release downloads

The three release downloads are hashed from real files with --download KEY=PATH (KEY: source,
portableModel, blender). Keys that are not given keep their previous hash entry when the previous
URL is unchanged; otherwise the lock stays "pending" for that key and `fetch_assets.py` refuses it.
Nothing is uploaded: publish the printed files under the printed release tag, then verify with
`python3 scripts/fetch_assets.py --check-downloads`.

Usage:
  python3 scripts/lock_assets.py --public-dir public --output-bundle .release/modern-bedroom-assets.zip \\
      --download source=.release/modern-bedroom-source.zip \\
      --download portableModel=/path/room-portable.glb --download blender=/path/room-master.blend
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_assets as fa  # noqa: E402

TAG = "img2interior-modern-bedroom-assets-v1"
BASE_URL = f"https://github.com/img2threejs/img2threejs-showcase/releases/download/{TAG}"
BUNDLE_NAME = "modern-bedroom-assets.zip"
DOWNLOAD_NAMES = {
    "source": "modern-bedroom-source.zip",
    "portableModel": "modern-bedroom-portable.glb",
    "blender": "modern-bedroom.blend",
}
RUNTIME_DIR = "assets/interior-runtime"
EXTRA_FILES = ["assets/reference.png"]
FIXED_TIME = (2020, 1, 1, 0, 0, 0)
STORED = {".glb", ".ktx2", ".bin", ".png", ".jpg", ".hdr", ".exr", ".zip"}
# The Pages budget is shared: nothing but the optimized runtime set belongs in the bundle.
FORBIDDEN_SUFFIXES = {".exr", ".blend"}


def fail(message):
    sys.exit(f"lock_assets: {message}")


def collect(public):
    names = []
    base = public / RUNTIME_DIR
    if not base.is_dir():
        fail(f"{base} not found; run `npm run optimize:assets` first")
    for path in sorted(base.rglob("*")):
        rel = path.relative_to(public)
        if any(part.startswith(".") for part in rel.parts):
            continue
        if path.is_symlink():
            fail(f"{rel} is a symlink (the optimizer's legacy links); remove it")
        if path.is_dir():
            continue
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            fail(f"{rel}: {path.suffix} must not ship in the runtime bundle (use KTX2/RGBE outputs)")
        names.append(rel.as_posix())
    for extra in EXTRA_FILES:
        if not (public / extra).is_file():
            fail(f"{extra} is missing")
        names.append(extra)
    for name in names:
        fa.safe_relative_path(name, "runtime set")
    return sorted(set(names))


def manifest_urls(manifest):
    urls = [manifest.get(k) for k in ("sourceImage", "model", "environment", "background")]
    urls += [a.get("url") for a in manifest.get("lightmaps", [])]
    samples = manifest.get("lightmapSamples") or {}
    urls += [samples.get("url"), samples.get("index")]
    urls.append((manifest.get("runtimeAssets") or {}).get("receipt"))
    return [u for u in urls if u is not None]


def check_manifest(public, names):
    manifest_path = public / RUNTIME_DIR / "manifest.json"
    if f"{RUNTIME_DIR}/manifest.json" not in names:
        fail("manifest.json missing from the runtime set")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("runtimeAssets"):
        fail("manifest.json has no runtimeAssets block: it is not an optimizer output")
    have = set(names)
    for url in manifest_urls(manifest):
        if not isinstance(url, str) or not url.startswith("/assets/") or ".." in url.split("/") or "//" in url:
            fail(f"invalid manifest URL {url!r}")
        if url[1:] not in have:
            fail(f"manifest references {url} which is not in the runtime set")
    for atlas in manifest.get("lightmaps", []):
        if not str(atlas.get("url", "")).endswith(".ktx2"):
            fail(f"lightmap {atlas.get('id')} is not KTX2: {atlas.get('url')}")
    if not manifest["runtimeAssets"].get("lightmapSamples"):
        fail("lightmap samples sidecars are missing from the optimizer manifest")
    if str(manifest["model"]).startswith("/assets/interior/"):
        fail("manifest.model still points at the unoptimized master")


def sha_and_size(path):
    return fa.sha256_of(path), path.stat().st_size


def write_bundle(public, names, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name in names:
                source = public / name
                info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
                info.compress_type = zipfile.ZIP_STORED if source.suffix.lower() in STORED else zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                info.file_size = source.stat().st_size
                with source.open("rb") as reader, archive.open(info, "w", force_zip64=info.file_size > (1 << 30)) as writer:
                    while True:
                        block = reader.read(fa.CHUNK)
                        if not block:
                            break
                        writer.write(block)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--public-dir", type=Path, default=ROOT / "public")
    parser.add_argument("--output-bundle", type=Path, default=ROOT / ".release" / BUNDLE_NAME)
    parser.add_argument("--lock", type=Path, default=ROOT / "assets.lock.json")
    parser.add_argument("--download", action="append", default=[], metavar="KEY=PATH", help="|".join(DOWNLOAD_NAMES))
    args = parser.parse_args()
    public = args.public_dir.resolve()

    names = collect(public)
    check_manifest(public, names)

    previous = {}
    if args.lock.is_file():
        previous = json.loads(args.lock.read_text(encoding="utf-8")).get("downloads", {})
    given = {}
    for item in args.download:
        key, _, value = item.partition("=")
        if key not in DOWNLOAD_NAMES or not value or not Path(value).is_file():
            fail(f"--download {item!r}: expected KEY=PATH with KEY in {sorted(DOWNLOAD_NAMES)} and an existing file")
        given[key] = Path(value)

    write_bundle(public, names, args.output_bundle.resolve())
    bundle_sha, bundle_bytes = sha_and_size(args.output_bundle)
    files = []
    for name in names:
        sha, size = sha_and_size(public / name)
        files.append({"path": name, "sha256": sha, "bytes": size})

    downloads = {}
    pending = []
    for key, filename in DOWNLOAD_NAMES.items():
        url = f"{BASE_URL}/{filename}"
        if key in given:
            sha, size = sha_and_size(given[key])
            downloads[key] = {"url": url, "sha256": sha, "bytes": size}
        elif isinstance(previous.get(key), dict) and previous[key].get("url") == url and previous[key].get("sha256"):
            downloads[key] = previous[key]
        else:
            downloads[key] = {"url": url}
            pending.append(key)

    lock = {
        "schemaVersion": 1,
        "bundle": {"url": f"{BASE_URL}/{BUNDLE_NAME}", "sha256": bundle_sha, "bytes": bundle_bytes},
        "files": files,
        "downloads": downloads,
    }
    if pending:
        lock["status"] = "pending"
        lock["pendingDownloads"] = pending
    args.lock.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    fa.load_lock(args.lock)  # the written lock must pass fetch validation
    total = sum(f["bytes"] for f in files)
    print(f"lock_assets: {len(files)} files, {total:,} bytes -> {args.lock}")
    print(f"lock_assets: bundle {args.output_bundle} ({bundle_bytes:,} bytes, sha256 {bundle_sha})")
    print(f"lock_assets: upload to release tag {TAG}: {BUNDLE_NAME}" + "".join(f", {DOWNLOAD_NAMES[k]}" for k in DOWNLOAD_NAMES))
    if pending:
        print(f"lock_assets: lock is PENDING; missing --download for: {', '.join(pending)}")
    else:
        print("lock_assets: lock complete; after upload run `python3 scripts/fetch_assets.py --check-downloads`")


if __name__ == "__main__":
    main()
