#!/usr/bin/env python3
"""Bundle the published viewer assets and pin their sizes and SHA-256 hashes.

Populate public/assets from the authored project's runtime manifest first. The portable
and native downloads and the separately hosted original references are excluded.
"""
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / 'public'
OUTPUT = ROOT / '.release' / 'warm-modern-house-assets.zip'
URL = 'https://github.com/img2threejs/img2threejs-showcase/releases/download/warm-modern-house-assets-v1/warm-modern-house-assets.zip'


def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()


manifest_path = PUBLIC / 'assets/interior/manifest.json'
manifest = json.loads(manifest_path.read_text())
urls = set()


def collect(value):
    if isinstance(value, str) and value.startswith('/assets/'):
        urls.add(value[1:])
    elif isinstance(value, list):
        for item in value:
            collect(item)
    elif isinstance(value, dict):
        for item in value.values():
            collect(item)


collect(manifest)
urls.difference_update(manifest['products'][key][1:] for key in ('portable', 'native'))
urls.add('assets/interior/manifest.json')
urls.difference_update(source['url'][1:] for source in manifest['sources'])
files = []
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(OUTPUT, 'w') as archive:
    for name in sorted(urls):
        parts = Path(name).parts
        if not parts or parts[0] != 'assets' or any(part in ('.', '..') for part in parts):
            raise ValueError(f'Invalid asset path: {name}')
        path = PUBLIC / name
        if not path.is_file() or path.is_symlink():
            raise ValueError(f'Missing or symlinked asset: {name}')
        files.append({'path': name, 'sha256': digest(path), 'bytes': path.stat().st_size})
        info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_STORED
        with path.open('rb') as source, archive.open(info, 'w') as target:
            for block in iter(lambda: source.read(1024 * 1024), b''):
                target.write(block)
references = []
for source in manifest['sources']:
    name = Path(source['url']).name
    image = ROOT / '.release' / 'references' / name
    if not image.is_file() or image.is_symlink():
        raise ValueError(f'Missing original reference: {name}')
    references.append({'path': source['url'], 'sha256': digest(image), 'bytes': image.stat().st_size})
lock = {'schemaVersion': 1, 'bundle': {'url': URL, 'sha256': digest(OUTPUT),
        'bytes': OUTPUT.stat().st_size}, 'files': files, 'downloads': {}, 'references': references}
(ROOT / 'assets.lock.json').write_text(json.dumps(lock, indent=2) + '\n')
print(f'Pinned {len(files)} assets ({sum(item["bytes"] for item in files)} bytes) in {OUTPUT}')
