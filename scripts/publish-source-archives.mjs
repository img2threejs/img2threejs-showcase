import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSourceReleaseManifest, sourceReleaseRepository } from './source-release.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.release/showcase-sources');
const repository = sourceReleaseRepository;
const api = `repos/${repository}`;
const manifestBytes = await readFile(path.join(stage, 'index.json'));
const manifest = JSON.parse(manifestBytes);
const expectedManifest = createSourceReleaseManifest(Object.entries(manifest.archives)
  .map(([id, { filename, bytes, sha256 }]) => ({ id, filename, bytes, sha256 })));
assert.deepEqual(manifest, expectedManifest, 'Source release manifest is not canonical');
assert.deepEqual(await readFile(path.join(root, 'dist/source/index.json')), manifestBytes,
  'Pages source catalog differs from staged release');
assert.deepEqual((await readdir(path.join(root, 'dist/source'))).sort(), ['index.json'],
  'Pages source output must contain only the catalog, not ZIPs');

async function digest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

const files = [...Object.values(manifest.archives), {
  filename: 'index.json', bytes: manifestBytes.length,
  sha256: createHash('sha256').update(manifestBytes).digest('hex'),
}];
assert.deepEqual((await readdir(stage)).sort(), files.map((file) => file.filename).sort(),
  'Release stage contains missing or unexpected files');
for (const file of files) {
  const filename = path.join(stage, file.filename);
  assert.equal((await stat(filename)).size, file.bytes, `${file.filename}: size mismatch`);
  assert.equal(await digest(filename), file.sha256, `${file.filename}: SHA-256 mismatch`);
}

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}
const gh = (...args) => run('gh', args);
const releaseIds = gh('api', `${api}/releases?per_page=100`, '--paginate', '--jq',
  `.[] | select(.tag_name == "${manifest.tag}") | .id`).split('\n').filter(Boolean);
assert(releaseIds.length <= 1, `Multiple releases use ${manifest.tag}; resolve the ambiguous drafts first`);
let releaseId = releaseIds[0];
if (!releaseId) {
  const target = process.env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']);
  // Use the authoritative creation response; a subsequent list request can lag behind the write.
  const created = JSON.parse(gh('api', `${api}/releases`, '--method', 'POST',
    '--raw-field', `tag_name=${manifest.tag}`, '--raw-field', `target_commitish=${target}`,
    '--raw-field', `name=Showcase source packages · ${manifest.tag.slice(-12)}`,
    '--raw-field', `body=${Object.keys(manifest.archives).length} standalone Three.js source packages, generated from the gallery checkout. Each ZIP preserves its original code, animation/VFX and required assets; no GLB/glTF loader is added.\n\nThe attached index.json records each archive's bytes and SHA-256. This content-addressed release is immutable and is published before the corresponding Pages catalog.`,
    '--field', 'draft=true', '--field', 'prerelease=true', '--raw-field', 'make_latest=false'));
  assert(Number.isSafeInteger(created.id) && created.id > 0, 'Release creation did not return an id');
  releaseId = String(created.id);
}
const readRelease = () => JSON.parse(gh('api', `${api}/releases/${releaseId}`));
const readAssets = () => gh('api', `${api}/releases/${releaseId}/assets?per_page=100`, '--paginate', '--jq', '.[] | @json')
  .split('\n').filter(Boolean).map((line) => JSON.parse(line));
let release = readRelease();
assert.equal(release.tag_name, manifest.tag);
const existing = new Map(readAssets().map((asset) => [asset.name, asset]));
const expectedNames = new Set(files.map((file) => file.filename));
for (const name of existing.keys()) assert(expectedNames.has(name), `Unexpected asset in immutable source release: ${name}`);
const pending = [];
for (const file of files) {
  const asset = existing.get(file.filename);
  if (!asset) {
    assert(release.draft, `Published source release is incomplete: ${file.filename}; refusing to mutate it`);
    pending.push(path.join(stage, file.filename));
  } else {
    assert.equal(asset.state, 'uploaded', `${file.filename}: remote upload is not complete`);
    assert.equal(asset.size, file.bytes, `${file.filename}: remote size differs; refusing to overwrite`);
    assert.equal(asset.digest, `sha256:${file.sha256}`, `${file.filename}: remote digest differs; refusing to overwrite`);
  }
}
if (pending.length) gh('release', 'upload', manifest.tag, '--repo', repository, ...pending);
function verifyAssets(assets, published) {
  assert.deepEqual(assets.map((asset) => asset.name).sort(), [...expectedNames].sort(), 'Remote release inventory differs');
  for (const file of files) {
    const asset = assets.find((candidate) => candidate.name === file.filename);
    assert.equal(asset.state, 'uploaded', `${file.filename}: remote upload incomplete`);
    assert.equal(asset.size, file.bytes, `${file.filename}: remote size mismatch`);
    assert.equal(asset.digest, `sha256:${file.sha256}`, `${file.filename}: remote SHA-256 mismatch`);
    if (published && file.url) assert.equal(asset.browser_download_url, file.url, 'Published download URL differs from Pages catalog');
  }
}
verifyAssets(readAssets(), false);
if (release.draft) gh('release', 'edit', manifest.tag, '--repo', repository, '--draft=false', '--prerelease', '--latest=false');
release = readRelease();
assert.equal(release.draft, false, 'Source release is not public');
verifyAssets(readAssets(), true);
console.log(`Source release verified: ${files.length - 1} ZIPs + index.json\n${release.html_url}`);
