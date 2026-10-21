"""Package linear runtime irradiance as ZIP-compressed HALF EXR, not display pixels.

Run after author_scene.py export with the project bpy Python. Keeps bake evidence,
probe, GLBs and packed master unchanged. The receipt links original and packaged
bytes and measures decoded error before replacing any served atlas.
"""
from argparse import ArgumentParser
from hashlib import sha256
from pathlib import Path
import json
import os
import time

import bpy
import numpy as np


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if not args.run_id or Path(args.run_id).name != args.run_id or args.run_id in ('.', '..'):
        raise ValueError('run-id must be a single directory name')
    root = args.workspace.resolve()
    out = root / '.img2/artifacts/interior/production' / args.run_id
    out.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((root / 'public/assets/interior/manifest.json').read_text())
    scene = bpy.context.scene
    scene.view_settings.view_transform = 'Raw'
    scene.render.image_settings.file_format = 'OPEN_EXR'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '16'
    scene.render.image_settings.exr_codec = 'ZIP'
    rows = []
    started = time.monotonic()
    for entry in manifest['lightmaps']:
        group, url = entry['id'], entry['url']
        path = root / 'public' / url.lstrip('/')
        source = bpy.data.images.load(str(path), check_existing=False)
        source.colorspace_settings.name = 'Non-Color'
        before = np.empty(len(source.pixels), dtype=np.float32)
        source.pixels.foreach_get(before)
        target = out / path.name
        source.save_render(str(target), scene=scene)
        decoded = bpy.data.images.load(str(target), check_existing=False)
        decoded.colorspace_settings.name = 'Non-Color'
        after = np.empty(len(decoded.pixels), dtype=np.float32)
        decoded.pixels.foreach_get(after)
        error = np.abs(after - before)
        relative = error / np.maximum(np.abs(before), 1e-3)
        if not np.all(np.isfinite(after)) or float(relative.max()) > 0.001:
            raise ValueError(f'{group}: HALF decode exceeds 0.1% normalized error')
        rows.append({'group': group, 'url': url, 'dimensions': list(source.size),
                     'sourceSha256': digest(path), 'sourceBytes': path.stat().st_size,
                     'sha256': digest(target), 'bytes': target.stat().st_size,
                     'maxAbsoluteLinearError': float(error.max()),
                     'meanAbsoluteLinearError': float(error.mean()),
                     'maxNormalizedLinearError': float(relative.max())})
        bpy.data.images.remove(source)
        bpy.data.images.remove(decoded)
        del before, after, error, relative
    # Validate all outputs first. Replacements affect only these generated sidecars.
    for row in rows:
        destination = root / 'public' / row['url'].lstrip('/')
        temporary = destination.with_suffix('.exr.half-tmp')
        temporary.write_bytes((out / destination.name).read_bytes())
        os.replace(temporary, destination)
    receipt = {'encoding': 'linear HALF RGBA ZIP EXR', 'displayTransformApplied': False,
               'probeAndNativeUnchanged': True, 'rows': rows,
               'sourceBytes': sum(r['sourceBytes'] for r in rows),
               'bytes': sum(r['bytes'] for r in rows),
               'elapsedSeconds': time.monotonic() - started}
    (out / 'packaging.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
