import { readFile, mkdir, writeFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { createHash } from 'node:crypto';
import { sourceCatalog, sourceStageDirectory } from './source-archives.mjs';
import { createSourceReleaseManifest, sourceArchiveFilename } from './source-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv.slice(2);
const temporary = await mkdtemp(path.join(tmpdir(), 'showcase-source-consumers-'));
let checked = 0;
try {
  const stage = path.join(root, sourceStageDirectory);
  const indexText = await readFile(path.join(stage, 'index.json'), 'utf8');
  const index = JSON.parse(indexText);
  const catalog = await sourceCatalog(root);
  assert.deepEqual(Object.keys(index.archives).sort(), catalog.map((entry) => entry.id).sort(), 'Release index must list exactly the showcase catalog');
  for (const [id, meta] of Object.entries(index.archives)) {
    assert.equal(meta.filename, sourceArchiveFilename(id), `Unexpected archive filename for ${id}`);
  }
  const expected = createSourceReleaseManifest(Object.entries(index.archives)
    .map(([id, { filename, bytes, sha256 }]) => ({ id, filename, bytes, sha256 })));
  assert.equal(indexText, JSON.stringify(expected, null, 2) + '\n', 'Release index differs from the canonical manifest');
  for (const entry of catalog) {
    // Every staged ZIP is verified, even when only some consumers are compiled; one archive is held at a time.
    const meta = index.archives[entry.id];
    const bytes = await readFile(path.join(stage, meta.filename));
    assert.equal(bytes.byteLength, meta.bytes, `${entry.id} archive byte size differs from index`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), meta.sha256, `${entry.id} archive SHA-256 differs from index`);
    if (selected.length && !selected.includes(entry.id)) continue;
    const archive = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(archive['manifest.json']));
    assert.equal(manifest.showcase, entry.id);
    assert.deepEqual(manifest.files, Object.keys(archive).sort());
    assert(!Object.keys(archive).some((name) => /\.(glb|gltf)$/i.test(name)), 'No binary/interchange models in source ZIP');
    const destination = path.join(temporary, entry.id);
    for (const [name, bytes] of Object.entries(archive)) {
      const target = path.resolve(destination, name);
      assert(target.startsWith(destination + path.sep), `Unsafe archive entry: ${name}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    // Package resolution is deliberately the only link to the gallery. No source/asset path is shared.
    await symlink(path.join(root, 'node_modules'), path.join(destination, 'node_modules'), 'dir');
    const compile = spawnSync(process.execPath, ['--max-old-space-size=8192',
      path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', destination], { encoding: 'utf8' });
    if (compile.status !== 0) throw new Error(`${entry.id} consumer typecheck failed:\n${compile.stdout}\n${compile.stderr}`);
    console.log(`${entry.id}: isolated consumer compiled (${Object.keys(archive).length} files)`);
    checked++;
  }
  assert(checked > 0, 'No selected showcase source archives were checked');
  console.log(`Source consumers: ${checked} passed; no GLB/glTF files`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
