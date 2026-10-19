#!/usr/bin/env python3
"""Build a runnable, standalone copy of this viewer (default public/source/modern-house.zip).

Python standard library only. Files are streamed one at a time (the scene assets
are tens of megabytes each), entries are sorted and timestamps are fixed so the
same inputs produce the same archive. Only files the viewer actually needs are
packaged; the archive never contains itself, node_modules, caches, research
outputs, environments, model weights or credentials.
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
DEFAULT_OUTPUT = ROOT / "public" / "source" / "modern-house.zip"
MANIFEST = ROOT / "public" / "assets" / "interior" / "manifest.json"
LOCK = ROOT / "assets.lock.json"
ARCHIVE_ROOT = "modern-house"
FIXED_TIME = (2020, 1, 1, 0, 0, 0)
CHUNK = 1 << 20

PROJECT_FILES = [
    "index.html",
    "viggle.html",
    "package.json",
    "package-lock.json",
    "vite.config.js",
    "assets.lock.json",
    "viggle-provenance.json",
    "hybrid-contract.json",
    "scripts/fetch_assets.py",
    "scripts/package_source.py",
    "public/favicon.svg",
]
# Already-compressed binary formats are stored as is; deflate would only cost time.
STORED_SUFFIXES = {".glb", ".exr", ".hdr", ".png", ".blend", ".jpg", ".jpeg", ".webp", ".spz", ".zip"}

README = """# Modern House Tour - Blender + Three.js + Viggle viewer (source)

A runnable copy of the interactive Modern House Tour: an authored, source-guided
house rendered with Three.js (WebGL 2), PBR materials, baked ambient lightmaps and a
shadowed sun, plus an isolated Viggle Gaussian-splat capture viewer with two scenes.

## Run

Requirements: Node.js 18+ (20+ recommended) and Python 3.8+ (the build step zips
the source for the in-page download).

```sh
npm ci
npm run dev        # development server
npm run build      # production build in dist/ (also regenerates public/source/modern-house.zip)
npm run preview    # serve the production build
```

To deploy under a sub-path, build with `npm run build -- --base=/your-path/`.
`npm run package:source` regenerates only the source archive. `npm run fetch:assets`
(also run before dev/build) verifies the scene assets against `assets.lock.json`;
they are already present in this archive, so no network access is needed.

## What is included

- `index.html`, `src/` - the Three.js house viewer, camera navigation and finish controls.
- `viggle.html`, `src/viggle*.js` - the isolated Viggle capture viewer (official
  `@viggle/splat-engine`, rotation in place at the capture origin).
- `assets.lock.json`, `scripts/fetch_assets.py` - SHA-256 pins for every scene asset and the
  stdlib-only verifier/fetcher that runs before dev and build.
- `public/assets/interior/` - runtime GLB, five EXR lightmaps, reflection probe,
  portable GLB, packed Blender master and `manifest.json`.
- `public/assets/viggle-house/scene.spz` - the default Viggle capture, reconstructed from an
  img2interior render of the authored house; `public/assets/viggle/scene.spz` - the original
  Viggle capture inferred from the source image, kept for comparison.
- `public/assets/reference.png` - the synthetic design reference (not a 3D render, not measured data).
- `viggle-provenance.json`, `hybrid-contract.json` - provenance and limits of the two captures.
- `package.json` / `package-lock.json` pin Three.js 0.180.0, @viggle/splat-engine 0.2.0,
  PlayCanvas 2.18.0 and Vite 6.4.1.

## Limits

- Dimensions, camera and hidden surfaces of the native house are authored estimates from a
  single synthetic image; nothing here is an exact 3D recovery of that image.
- The default Viggle capture is a single-viewpoint reconstruction from an img2interior render
  of the authored house; unseen areas are filled in by the engine and scale is arbitrary.
  The original Viggle capture is kept for comparison; its layout differs from the authored house.
- The native house and the Viggle captures are independent representations and are not
  registered to each other.
- Sunlight and shadows are real time; indirect light and reflections stay baked. This is not
  full dynamic global illumination, a live mirror or ray-traced glass.
- The portable GLB and the Blender file are exports of the authored scene. The portable GLB
  uses unlit baked appearance, so reflections differ from the viewer.

## Credits

Some models, textures and the HDRI come from [Poly Haven](https://polyhaven.com/) (CC0 1.0).
The design reference image is a synthetic image and is not covered by that CC0 statement.
The Viggle captures were generated with Viggle PINOC. Details: `THIRD_PARTY_NOTICES.txt`.
The authoring pipeline (Blender scripts, research outputs) is not part of this archive.
"""

GITIGNORE = "node_modules/\ndist/\npublic/source/\n.site-public/\n.release/\n.DS_Store\n"

LICENSE_PACKAGES = ("three", "playcanvas", "@viggle/splat-engine")


def fail(message: str) -> "None":
    sys.exit(f"package_source: {message}")


def safe_asset(name: object) -> str:
    if not isinstance(name, str) or not name.startswith("assets/") or ".." in name.split("/") or "\\" in name or "//" in name:
        fail(f"invalid asset path: {name!r}")
    return name


def declared_assets() -> list[str]:
    """Every asset in assets.lock.json; the manifest's own references must be a subset."""
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    locked = {safe_asset(entry.get("path")) for entry in lock["files"]}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    urls = [manifest.get(key) for key in ("sourceImage", "model", "portableModel", "blender", "environment", "background")]
    urls += [atlas.get("url") for atlas in manifest.get("lightmaps", [])]
    for url in urls:
        if url is None:
            continue
        if not isinstance(url, str) or not url.startswith("/assets/"):
            fail(f"invalid manifest asset path: {url!r}")
        if safe_asset(url[1:]) not in locked:
            fail(f"manifest asset {url} is not pinned in assets.lock.json")
    if "assets/interior/manifest.json" not in locked:
        fail("assets.lock.json does not pin assets/interior/manifest.json")
    return sorted(locked)


def package_license(name: str) -> str:
    # npm workspaces hoist dependencies, so look next to the package first and then in the repository root.
    for base in (ROOT / "node_modules", ROOT.parent.parent / "node_modules"):
        for candidate in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
            path = base / name / candidate
            if path.is_file():
                return path.read_text(encoding="utf-8").strip()
    fail(f"node_modules/{name}/LICENSE not found; run `npm ci` first so the notice can be included")


def notices() -> str:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    deps = package["dependencies"]
    sections = "\n\n".join(f"{name}\n{'-' * len(name)}\n{package_license(name)}" for name in LICENSE_PACKAGES)
    return f"""Third-party notices
===================

This archive does not vendor node_modules. `npm ci` installs the pinned packages:
three {deps['three']}, playcanvas {deps['playcanvas']} and @viggle/splat-engine {deps['@viggle/splat-engine']}
(bundled into the viewer builds) and vite {package['devDependencies']['vite']} (build tool, MIT licence,
not bundled).

{sections}

Poly Haven assets
-----------------
Some models, textures and the HDRI environment come from Poly Haven
(https://polyhaven.com/) under the CC0 1.0 licence (https://polyhaven.com/license).
Surface maps and the authored geometry are derivatives made for this scene.

Design reference image
----------------------
public/assets/reference.png is a synthetic design reference image. It is not a Poly Haven
asset and no CC0 claim is made for it. It is a design reference, not measured data.

Viggle captures
---------------
public/assets/viggle/scene.spz and public/assets/viggle-house/scene.spz are Gaussian-splat
captures generated with Viggle PINOC (see viggle-provenance.json). They are rendered by the
official @viggle/splat-engine package listed above.
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


def source_tree() -> list[str]:
    return sorted(path.relative_to(ROOT).as_posix() for path in (ROOT / "src").rglob("*") if path.is_file() and path.name != ".DS_Store")


def parse_output() -> Path:
    parser = argparse.ArgumentParser(description="Package the standalone modern-house source archive.")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="archive path (default: public/source/modern-house.zip)")
    return parser.parse_args().output.resolve()


def main() -> None:
    output = parse_output()
    files = {name: ROOT / name for name in PROJECT_FILES + source_tree()}
    files.update({f"public/{name}": ROOT / "public" / name for name in declared_assets()})
    extra = {"README.md": README, "THIRD_PARTY_NOTICES.txt": notices(), ".gitignore": GITIGNORE}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    try:
        with zipfile.ZipFile(temporary, "w") as archive:
            for name in sorted({**{n: None for n in files}, **{n: None for n in extra}}):
                if name in extra:
                    add_bytes(archive, name, extra[name].encode("utf-8"))
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
