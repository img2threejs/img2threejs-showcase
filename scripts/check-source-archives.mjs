import { readFile, mkdir, writeFile, mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { sourceCatalog } from './source-archives.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv.slice(2);
const temporary = await mkdtemp(path.join(tmpdir(), 'showcase-source-consumers-'));
let checked = 0;
try {
  for (const entry of await sourceCatalog(root)) {
    if (selected.length && !selected.includes(entry.id)) continue;
    const archive = unzipSync(new Uint8Array(await readFile(path.join(root, 'dist/source', `${entry.id}.zip`))));
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
