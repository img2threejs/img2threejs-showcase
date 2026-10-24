import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { createSourceArchive, sourceCatalog } from './source-archives.mjs';

// The archive builder walks the whole dependency graph, so a deeply nested expression must
// still yield a package a consumer can extract, import and run.
const chainTerms = 8000;
const siblingValue = 'sibling-value';
const lazyValue = 'lazy-value';
const sentinelText = 'source-archive-sentinel\n';

function concatenation(count) {
  const terms = [];
  for (let index = 0; index < count; index++) terms.push(`'${index % 10}'`);
  return terms.join(' + ');
}

function expectedValue(count) {
  let value = '';
  for (let index = 0; index < count; index++) value += String(index % 10);
  return value;
}

/** A self-contained miniature package: registry, one deep module, sibling and lazy modules, and a module-relative asset. */
async function writeFixture(root) {
  await mkdir(path.join(root, 'scripts/source-package'), { recursive: true });
  await mkdir(path.join(root, 'src/demos'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'source-archive-fixture',
    private: true,
    type: 'module',
    dependencies: { three: '^0.169.0' },
    devDependencies: { '@types/three': '^0.169.0', typescript: '^5.6.0', vite: '^5.4.0' },
  }, null, 2) + '\n');
  await writeFile(path.join(root, 'scripts/source-package/index.template'),
    "export { value } from './demos/deep.js';\n");
  await writeFile(path.join(root, 'scripts/source-package/example.template'), 'export {};\n');
  await writeFile(path.join(root, 'src/demos/registry.ts'), [
    "import { value } from './deep.js';",
    '',
    'export const authored = [',
    "  { id: 'deep-chain', name: 'Deep Chain', summary: String(value.length) },",
    '];',
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'src/demos/deep.js'), [
    "import { sibling } from './sibling.js';",
    '',
    'export { sibling };',
    '',
    `export const value = ${concatenation(chainTerms)};`,
    '',
    "export const assetUrl = new URL('./sentinel.txt', import.meta.url);",
    '',
    "export function loadLazy() { return import('./lazy.js'); }",
    '',
  ].join('\n'));
  await writeFile(path.join(root, 'src/demos/sibling.js'), `export const sibling = ${JSON.stringify(siblingValue)};\n`);
  await writeFile(path.join(root, 'src/demos/lazy.js'), `export const lazy = ${JSON.stringify(lazyValue)};\n`);
  await writeFile(path.join(root, 'src/demos/sentinel.txt'), sentinelText);
}

/** Unpack the produced ZIP so the archive is consumed exactly as a consumer would consume it. */
async function extractArchive(archive, target) {
  const entries = unzipSync(archive);
  for (const [name, bytes] of Object.entries(entries)) {
    const destination = path.join(target, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

test('an archive with a deeply nested expression stays consumable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-archive-fixture-'));
  const extracted = await mkdtemp(path.join(tmpdir(), 'source-archive-output-'));
  try {
    await writeFixture(root);
    const [entry] = await sourceCatalog(root);

    const archive = await createSourceArchive(root, entry, []);
    await extractArchive(archive, extracted);

    const module = await import(pathToFileURL(path.join(extracted, 'src/demos/deep.js')).href);
    assert.equal(module.value, expectedValue(chainTerms));
    assert.equal(module.sibling, siblingValue);
    assert.equal(await readFile(fileURLToPath(module.assetUrl), 'utf8'), sentinelText);
    const lazy = await module.loadLazy();
    assert.equal(lazy.lazy, lazyValue);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(extracted, { recursive: true, force: true });
  }
});
