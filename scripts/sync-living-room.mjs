#!/usr/bin/env node
/**
 * Explicit maintenance command: refresh showcases/living-room from the canonical Living Room
 * project. Never run implicitly by build/dev. Usage:
 *
 *   node scripts/sync-living-room.mjs --from /path/to/kiss-gs-real-photo-experiment
 *
 * Copies (byte-exact) index.html, src/**, and only the files the viewer actually declares (manifest
 * fields, lightmap atlases, '/assets/...' literals in index.html / src). This repo's own vite.config.js,
 * package.json scripts, scripts/package_source.py, fetcher and assets.lock.json are never overwritten.
 * Before touching anything it requires the declared asset inventory and every file's size/SHA-256 to
 * match assets.lock.json (the fetcher would otherwise overwrite changed assets with the pinned release
 * ones); on mismatch it fails without changes. Historical models, weights, evidence and unrelated
 * assets are never copied; synced public/assets is gitignored, and .site-public, .release, dist,
 * node_modules and source ZIPs are not touched.
 */
import { createHash } from 'node:crypto';
import { createReadStream, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'showcases', 'living-room');
const fromIndex = process.argv.indexOf('--from');
if (fromIndex < 0 || !process.argv[fromIndex + 1]) {
  console.error('usage: node scripts/sync-living-room.mjs --from <canonical living-room project>');
  process.exit(2);
}
const source = resolve(process.argv[fromIndex + 1]);
const MANIFEST = 'assets/interior/manifest.json';
const manifestPath = join(source, 'public', MANIFEST);
if (!existsSync(manifestPath) || !existsSync(join(source, 'index.html')) || !existsSync(join(source, 'src'))) {
  console.error(`not a Living Room project: ${source}`);
  process.exit(1);
}

const declared = new Set([MANIFEST]);
const collect = (value) => {
  if (typeof value === 'string') {
    if (/^\/assets\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(value)) declared.add(value.slice(1));
  } else if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
};
collect(JSON.parse(readFileSync(manifestPath, 'utf8')));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
for (const file of [join(source, 'index.html'), ...walk(join(source, 'src'))]) {
  for (const [path] of readFileSync(file, 'utf8').matchAll(/\/assets\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g)) {
    declared.add(path.slice(1));
  }
}
const missing = [...declared].filter((rel) => !existsSync(join(source, 'public', rel)));
if (missing.length) {
  console.error(`declared assets missing in canonical project:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

if (!existsSync(join(source, 'package.json'))) {
  console.error('canonical package.json missing');
  process.exit(1);
}
// This repo owns the Vite/packager/package adapter that implements release-hosted downloads, so the
// canonical runtime must expose the matching optional hook; an older one would silently drop it.
const HOOK = 'VITE_LIVING_ROOM_DOWNLOADS';
if (!walk(join(source, 'src')).some((file) => readFileSync(file, 'utf8').includes(HOOK))) {
  console.error(`canonical src lacks the optional ${HOOK} download hook; propagate it to the canonical project first (refusing to overwrite hook support).`);
  process.exit(1);
}
// The workspace package keeps its own scoped name; everything else must match the canonical pins.
const canon = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const local = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
for (const key of ['dependencies', 'devDependencies']) {
  if (JSON.stringify(canon[key]) !== JSON.stringify(local[key])) {
    console.error(`canonical package.json "${key}" differs from showcases/living-room/package.json; update the child package (and its lock) deliberately first.`);
    process.exit(1);
  }
}

// The fetcher re-installs assets.lock.json bytes on every dev/build, so a changed canonical asset
// would be silently overwritten. Require the declared inventory and every byte to match the lock
// before anything in the target is touched. Hashing streams; no whole-file buffers.
const lock = JSON.parse(readFileSync(join(target, 'assets.lock.json'), 'utf8'));
const locked = new Map(lock.files.map((file) => [file.path, file]));
const problems = [
  ...[...declared].filter((rel) => !locked.has(rel)).map((rel) => `not in assets.lock.json: ${rel}`),
  ...[...locked.keys()].filter((rel) => !declared.has(rel)).map((rel) => `locked but no longer declared: ${rel}`),
];
const sha256 = (file) => new Promise((done, fail) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', fail).on('end', () => done(hash.digest('hex')));
});
for (const rel of [...declared].filter((item) => locked.has(item)).sort()) {
  const expected = locked.get(rel);
  const file = join(source, 'public', rel);
  if (statSync(file).size !== expected.bytes) problems.push(`size differs from lock: ${rel}`);
  else if ((await sha256(file)) !== expected.sha256) problems.push(`sha256 differs from lock: ${rel}`);
}
if (problems.length) {
  console.error(`canonical assets do not match showcases/living-room/assets.lock.json:\n  ${problems.join('\n  ')}\nPublish a new release version and update assets.lock.json deliberately first; nothing was changed.`);
  process.exit(1);
}
rmSync(join(target, 'src'), { recursive: true, force: true });
rmSync(join(target, 'public', 'assets'), { recursive: true, force: true });
mkdirSync(join(target, 'public'), { recursive: true });
cpSync(join(source, 'index.html'), join(target, 'index.html'));
cpSync(join(source, 'src'), join(target, 'src'), { recursive: true });
let bytes = 0;
for (const rel of [...declared].sort()) {
  const from = join(source, 'public', rel);
  mkdirSync(dirname(join(target, 'public', rel)), { recursive: true });
  cpSync(from, join(target, 'public', rel));
  bytes += statSync(from).size;
}
console.log(`living-room: synced ${declared.size} assets (${(bytes / 1048576).toFixed(1)} MiB) from ${source}`);
