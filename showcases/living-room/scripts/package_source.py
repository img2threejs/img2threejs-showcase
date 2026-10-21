#!/usr/bin/env python3
"""Build a runnable, standalone copy of this viewer (default public/source/living-room.zip).

Python standard library only. Files are streamed one at a time (the scene assets
are hundreds of megabytes), entries are sorted and timestamps are fixed so the
same inputs produce the same archive. Only files the viewer actually needs are
packaged; the archive never contains itself, node_modules, caches, research
outputs, environments, model weights or credentials.
"""
from __future__ import annotations

import json
import os
import shutil
import argparse
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "public" / "source" / "living-room.zip"
MANIFEST = ROOT / "public" / "assets" / "interior" / "manifest.json"
ARCHIVE_ROOT = "living-room"
FIXED_TIME = (2020, 1, 1, 0, 0, 0)
CHUNK = 1 << 20

PROJECT_FILES = [
    "index.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "assets.lock.json",
    "scripts/fetch_assets.py",
    "scripts/package_source.py",
    "scripts/pack_runtime_assets.mjs",
    "src/interior.js",
    "src/interior-curtains.js",
    "src/interior-navigation.js",
    "src/interior.css",
]
# Already-compressed binary formats are stored as is; deflate would only cost time.
STORED_SUFFIXES = {".glb", ".exr", ".hdr", ".png", ".blend", ".jpg", ".jpeg", ".zip"}

README = """# Living room - Blender + Three.js viewer (source)

A runnable copy of the interactive living-room viewer: a Blender-authored scene
rendered with Three.js (WebGL 2), PBR materials and baked ambient lightmaps, with
a shadowed sun, interactive curtains and three sofa finishes.

## Run

Requirements: Node.js 18+ (20+ recommended) and Python 3.8+ (the build step zips
the source for the in-page download).

```sh
npm ci
npm run dev        # development server
npm run build      # production build in dist/ (also regenerates public/source/living-room.zip)
npm run preview    # serve the production build
```

To deploy under a sub-path, build with `npm run build -- --base=/your-path/`.
`npm run package:source` regenerates only the source archive. `npm run fetch:assets`
(also run before dev/build) verifies the twelve scene assets against `assets.lock.json`;
they are already present in this archive, so no network access is needed.

## What is included

- `index.html`, `src/` - the viewer, curtain interaction and camera navigation.
- `assets.lock.json`, `scripts/fetch_assets.py` - SHA-256 pins for every scene asset and the
  stdlib-only verifier/fetcher that runs before dev and build.
- `public/assets/interior/` - runtime GLB, five EXR lightmaps, reflection probe,
  garden HDR, portable GLB, packed Blender master and `manifest.json`.
- `public/assets/interior-modern-source.png` - the synthetic design reference
  (not a 3D render, not measured data).
- `package.json` / `package-lock.json` pin Three.js 0.180.0 and Vite 6.4.1.

## Limits

- Dimensions, camera and hidden surfaces are estimates from a single synthetic image.
- Sunlight and shadows follow the curtains; indirect light and reflections stay
  baked at open curtains. This is not full dynamic global illumination.
- The portable GLB and the Blender file are exports of the original state (open
  curtains, cream sofa). They do not contain cloth simulation or the live state of
  the viewer. The portable GLB uses unlit baked appearance, so reflections differ.

## Credits

Some models, textures and the HDRI come from [Poly Haven](https://polyhaven.com/)
(CC0 1.0). The design reference image is a synthetic image generated with Customuse
and is not covered by that CC0 statement. Details: `THIRD_PARTY_NOTICES.txt`. The
authoring pipeline (Blender scripts, research outputs) is not part of this archive.
"""

GITIGNORE = "node_modules/\ndist/\npublic/source/\n.site-public/\n.release/\n.DS_Store\n"


def fail(message: str) -> "None":
    sys.exit(f"package_source: {message}")


def declared_assets() -> list[str]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    urls = [manifest.get(key) for key in ("sourceImage", "model", "portableModel", "blender", "environment", "background")]
    urls += [atlas.get("url") for atlas in manifest.get("lightmaps", [])]
    assets = []
    for url in urls:
        if url is None:
            continue
        if not isinstance(url, str) or not url.startswith("/assets/") or ".." in url.split("/") or "\\" in url or "//" in url:
            fail(f"invalid manifest asset path: {url!r}")
        assets.append(url[1:])
    assets.append("assets/interior/manifest.json")
    return sorted(set(assets))


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

Poly Haven assets
-----------------
Some models, textures and the HDRI environment come from Poly Haven
(https://polyhaven.com/) under the CC0 1.0 licence (https://polyhaven.com/license).
Linen, oak, walnut, leather, marble and rug surface maps are derivatives authored for
this scene.

Design reference image
----------------------
public/assets/interior-modern-source.png is a synthetic image generated with Customuse
(Nano Banana 2, project https://customuse.com/workflow/a074a7e1-d15f-4f7d-8586-282d01a1aedf).
It is not a Poly Haven asset and no CC0 claim is made for it. It is a design reference,
not measured data.
"""


def add_bytes(archive: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{name}", date_time=FIXED_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    archive.writestr(info, data)


def add_file(archive: zipfile.ZipFile, name: str, source: Path) -> None:
    if not source.is_file():
        fail(f"missing required file: {source.relative_to(ROOT)}")
    info = zipfile.ZipInfo(f"{ARCHIVE_ROOT}/{name}", date_time=FIXED_TIME)
    info.compress_type = zipfile.ZIP_STORED if source.suffix.lower() in STORED_SUFFIXES else zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.file_size = source.stat().st_size
    with source.open("rb") as reader, archive.open(info, "w", force_zip64=info.file_size > (1 << 30)) as writer:
        shutil.copyfileobj(reader, writer, CHUNK)


def parse_output() -> Path:
    parser = argparse.ArgumentParser(description="Package the standalone living-room source archive.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="archive path (default: public/source/living-room.zip)")
    return parser.parse_args().output.resolve()


def main() -> None:
    output = parse_output()
    files = {name: ROOT / name for name in PROJECT_FILES}
    files.update({name: ROOT / "public" / name for name in declared_assets()})
    extra = {"README.md": README, "THIRD_PARTY_NOTICES.txt": notices(), ".gitignore": GITIGNORE}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name in sorted({**{n: None for n in files}, **{n: None for n in extra}}):
                if name in extra:
                    add_bytes(archive, name, extra[name].encode("utf-8"))
                else:
                    add_file(archive, name if name in PROJECT_FILES else f"public/{name}", files[name])
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
