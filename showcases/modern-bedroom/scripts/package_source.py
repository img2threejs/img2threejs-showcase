#!/usr/bin/env python3
"""Build the standalone, runnable source archive of the modern-bedroom showcase.

Default output: .release/modern-bedroom-source.zip (uploaded as a release asset, never committed).
Python standard library only; entries are sorted and timestamps fixed, so identical inputs give an
identical archive. Strictly allowlisted: the viewer project, the Blender/Python authoring sources
(authoring/*.py, spec, material policy, resource selection) and authoring/resources with provenance
(source.json, LICENSE*) plus the CC0 source maps. It never contains node_modules, caches, hidden
directories (.omp/.jev/.img2/.git/environments), env files, credentials, key material or history.
The runtime binaries are not inside: `npm run fetch:assets` installs them from assets.lock.json.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / ".release" / "modern-bedroom-source.zip"
ARCHIVE_ROOT = "modern-bedroom"
FIXED_TIME = (2020, 1, 1, 0, 0, 0)
CHUNK = 1 << 20

PROJECT_FILES = [
    "index.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "assets.lock.json",
    "scripts/fetch_assets.py",
    "scripts/lock_assets.py",
    "scripts/package_source.py",
    "scripts/optimize_runtime_assets.mjs",
    "scripts/sync-bedcloth-manifest.mjs",
]
SRC_SUFFIXES = {".js", ".css", ".json"}
AUTHORING_FILES = [
    "authoring/build_scene.py",
    "authoring/bedroom_materials.py",
    "authoring/build_background.py",
    "authoring/prepare_bedroom_fabrics.py",
    "authoring/prepare_runtime_atlases.py",
    "authoring/scene-spec.json",
    "authoring/material-policy.json",
    "authoring/surfaces.json",
    "authoring/resource-selection.json",
    "authoring/interior-intake.json",
    "authoring/reference-result.json",
]
OPTIONAL_AUTHORING = ["authoring/README.md", "authoring/reference-request.json", "authoring/reference-operation.json"]
RESOURCE_SUFFIXES = {".json", ".txt", ".md", ".jpg", ".jpeg", ".png", ".exr", ".hdr"}
RESOURCE_NAMES = {"LICENSE", "LICENSE.txt", "LICENSE.md"}
DENIED_PARTS = {"node_modules", "__pycache__", "environments", "environment", "history", "dist"}
DENIED_NAMES = {".env", ".npmrc", ".netrc", "id_rsa", "id_ed25519"}
DENIED_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".log"}
STORED_SUFFIXES = {".glb", ".exr", ".hdr", ".png", ".blend", ".jpg", ".jpeg", ".zip"}

README = """# Walnut / Petrol Bedroom - Blender + Three.js viewer (source)

A runnable copy of the interactive modern-bedroom showcase: a Blender-authored scene rendered
with Three.js 0.180 (WebGL 2) with baked ambient lightmaps, shadowed sun, interactive curtains,
a draggable throw and a palette of finishes.

## Run

Requirements: Node.js 18+ (20+ recommended) and Python 3.8+.

```sh
npm ci
npm run dev        # fetches + verifies the runtime assets (assets.lock.json), then serves
npm run build      # production build (also regenerates .release/modern-bedroom-source.zip)
npm run preview
```

Deploy under a sub-path with `npm run build -- --base=/your-path/`.

## Assets

The runtime set (meshopt + KTX2 GLB, KTX2 lightmaps, `lightmap-samples.bin/.json`, Radiance
probes, manifests) is not stored in the archive. `assets.lock.json` pins its release bundle by
SHA-256; `scripts/fetch_assets.py` downloads and verifies it into `public/` (`--bundle FILE` installs a
local copy). The same lock lists the portable GLB and the packed Blender master that the page offers
as downloads (`python3 scripts/fetch_assets.py --check-downloads` verifies them).
The Basis/KTX2 transcoder is copied from `three` at build time to `vendor/basis/`.

## What is included

- `index.html`, `src/` - viewer, curtain and bed-cloth interaction, navigation, palette, loader.
- `scripts/` - fetch/lock/package tooling and `optimize_runtime_assets.mjs`, the offline optimizer
  (masters -> runtime set; needs the Blender exports and `basisu`).
- `authoring/` - the Blender/Python build sources (`build_scene.py`, materials, fabric and atlas
  preparation), `scene-spec.json`, `material-policy.json`, resource selection and provenance.
- `authoring/resources/` - the CC0 source maps with their `source.json` / `LICENSE` provenance.

## Limits

- Dimensions, camera and hidden surfaces are estimates from a single synthetic image.
- Sunlight and shadows are dynamic; indirect light and reflections stay baked. This is not full
  dynamic global illumination.
- The portable GLB and Blender file are exports of the authored state; they contain no live cloth
  state of the viewer.

## Credits

Textures come from [Poly Haven](https://polyhaven.com/) and [ambientCG](https://ambientcg.com/)
(CC0 1.0). The design reference image is synthetic (Customuse / Nano Banana 2) and not covered by
that CC0 statement. Details: `THIRD_PARTY_NOTICES.txt`.
"""

GITIGNORE = "node_modules/\ndist/\npublic/assets/\npublic/source/\n.site-public/\n.release/\n__pycache__/\n.DS_Store\n"


def fail(message: str):
    sys.exit(f"package_source: {message}")


def denied(rel: Path) -> bool:
    parts = rel.parts
    return (
        any(p.startswith(".") for p in parts)
        or any(p in DENIED_PARTS for p in parts)
        or rel.name in DENIED_NAMES
        or rel.suffix.lower() in DENIED_SUFFIXES
        or rel.name.lower().startswith(".env")
    )


def collect() -> dict[str, Path]:
    files: dict[str, Path] = {}
    for name in PROJECT_FILES + AUTHORING_FILES:
        files[name] = ROOT / name
    files.pop("assets.lock.json")  # replaced by archived_lock()
    for name in OPTIONAL_AUTHORING:
        if (ROOT / name).is_file():
            files[name] = ROOT / name
    src = ROOT / "src"
    found = [p for p in sorted(src.rglob("*")) if p.is_file() and p.suffix.lower() in SRC_SUFFIXES] if src.is_dir() else []
    if not found:
        fail("src/ has no viewer sources")
    for path in found:
        files[path.relative_to(ROOT).as_posix()] = path
    resources = ROOT / "authoring" / "resources"
    if not resources.is_dir():
        fail("authoring/resources not found; the source archive must carry resource provenance")
    for path in sorted(resources.rglob("*")):
        rel = path.relative_to(ROOT)
        if path.is_dir():
            continue
        if denied(rel.relative_to("authoring/resources")):
            continue
        if path.suffix.lower() in RESOURCE_SUFFIXES or path.name in RESOURCE_NAMES:
            files[rel.as_posix()] = path
    if not any(n.endswith("source.json") for n in files if n.startswith("authoring/resources/")):
        fail("authoring/resources contains no source.json provenance")
    for name, path in files.items():
        if path.is_symlink() or not path.is_file():
            fail(f"missing or non-regular required file: {name}")
        if denied(Path(name)):
            fail(f"refusing to package denied path: {name}")
    return files


def archived_lock() -> str:
    """assets.lock.json as stored in the archive: the source ZIP cannot pin its own hash.

    downloads.source keeps its URL only; status/pendingDownloads are dropped once every other download is hashed.
    Derived solely from the lock minus the source hash, so regenerating after the final lock gives the same archive.
    """
    lock = json.loads((ROOT / "assets.lock.json").read_text(encoding="utf-8"))
    downloads = lock.get("downloads", {})
    if "source" in downloads:
        downloads["source"] = {"url": downloads["source"]["url"]}
    pending = [k for k, v in downloads.items() if k != "source" and "sha256" not in v]
    if pending:
        lock["pendingDownloads"] = pending
    else:
        lock.pop("status", None)
        lock.pop("pendingDownloads", None)
    return json.dumps(lock, indent=2) + "\n"


def notices() -> str:
    license_path = ROOT / "node_modules" / "three" / "LICENSE"
    if not license_path.is_file():
        fail("node_modules/three/LICENSE not found; run `npm ci` first so the notice can be included")
    three = license_path.read_text(encoding="utf-8").strip()
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    return f"""Third-party notices
===================

This archive does not vendor node_modules. `npm ci` installs the pinned packages:
three {package['dependencies']['three']} (bundled into the viewer build) and
vite {package['devDependencies']['vite']} (build tool, MIT licence, not bundled).

three.js
--------
{three}

Poly Haven and ambientCG textures
---------------------------------
Individual texture maps (black_walnut_veneer_02, wooden_floor_02 from Poly Haven,
https://polyhaven.com/license; Fabric085 from ambientCG, https://docs.ambientcg.com/license/)
are CC0 1.0. Per-asset provenance and licence text: authoring/resources/**/source.json and
LICENSE files. Surface maps used in the scene are derivatives authored by
authoring/prepare_bedroom_fabrics.py and authoring/build_scene.py.

Design reference image
----------------------
public/assets/reference.png is a synthetic image generated with Customuse (Nano Banana 2); see
authoring/reference-result.json. It is not a CC0 asset and no CC0 claim is made for it. It is a
design reference, not measured data.
"""


def zip_info(name: str, compress: int) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{name}", date_time=FIXED_TIME)
    info.compress_type = compress
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def add_file(archive: zipfile.ZipFile, name: str, source: Path) -> None:
    compress = zipfile.ZIP_STORED if source.suffix.lower() in STORED_SUFFIXES else zipfile.ZIP_DEFLATED
    info = zip_info(name, compress)
    info.file_size = source.stat().st_size
    with source.open("rb") as reader, archive.open(info, "w", force_zip64=info.file_size > (1 << 30)) as writer:
        shutil.copyfileobj(reader, writer, CHUNK)


def main() -> None:
    parser = argparse.ArgumentParser(description="Package the standalone modern-bedroom source archive.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="archive path (default: .release/modern-bedroom-source.zip)")
    output = parser.parse_args().output.resolve()
    files = collect()
    extra = {"assets.lock.json": archived_lock(), "README.md": README, "THIRD_PARTY_NOTICES.txt": notices(), ".gitignore": GITIGNORE}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name in sorted({*files, *extra}):
                if name in extra:
                    archive.writestr(zip_info(name, zipfile.ZIP_DEFLATED), extra[name].encode("utf-8"))
                else:
                    add_file(archive, name, files[name])
        os.replace(temporary, output)
    finally:
        if temporary.exists():
            temporary.unlink()
    try:
        shown = output.relative_to(ROOT)
    except ValueError:
        shown = output
    print(f"package_source: wrote {shown} ({output.stat().st_size:,} bytes, {len(files) + len(extra)} files)")


if __name__ == "__main__":
    main()
