#!/usr/bin/env node
/**
 * Explicit maintenance command: refresh showcases/modern-house from the canonical Modern House
 * authoring project (work/modern-house-interior: Blender scripts, bpy venv, evidence, resources).
 * Never run implicitly by build/dev. Usage:
 *
 *   node scripts/sync-modern-house.mjs --from work/modern-house-interior
 *
 * Mirrors scripts/sync-living-room.mjs. Copies (byte-exact) index.html, viggle.html, src/**,
 * public/favicon.svg, the provenance/contract JSON, and only the files the viewer actually
 * declares (manifest fields and 'assets/...' literals in index.html / viggle.html / src). The
 * showcase packaging (vite.config.js, package.json scripts, assets.lock.json, scripts/, tests/) is
 * owned by showcases/modern-house and is never overwritten. After a sync, regenerate
 * assets.lock.json and republish the release bundle. Authoring
 * scripts, the packed bpy environment, intermediates, evidence, portable atlas PNGs and the
 * source panorama are never copied.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '..', 'showcases', 'modern-house');
const fromIndex = process.argv.indexOf('--from');
if (fromIndex < 0 || !process.argv[fromIndex + 1]) {
  console.error('usage: node scripts/sync-modern-house.mjs --from <canonical modern-house project>');
  process.exit(2);
}
const source = resolve(process.argv[fromIndex + 1]);
const MANIFEST = 'assets/interior/manifest.json';
const manifestPath = join(source, 'public', MANIFEST);
for (const required of [manifestPath, join(source, 'index.html'), join(source, 'viggle.html'), join(source, 'src')]) {
  if (!existsSync(required)) {
    console.error(`not a Modern House project (missing ${required})`);
    process.exit(1);
  }
}

const declared = new Set([MANIFEST]);
const assetPattern = /(?<![A-Za-z0-9_.-])\/?(assets\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)/g;
const collect = (value) => {
  if (typeof value === 'string') {
    for (const [, path] of value.matchAll(assetPattern)) declared.add(path);
  } else if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === 'object') Object.values(value).forEach(collect);
};
collect(JSON.parse(readFileSync(manifestPath, 'utf8')));

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
});
for (const file of [join(source, 'index.html'), join(source, 'viggle.html'), ...walk(join(source, 'src'))]) {
  for (const [, path] of readFileSync(file, 'utf8').matchAll(assetPattern)) declared.add(path);
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
// The workspace package keeps its own scoped name and showcase scripts; the pinned dependency sets must match.
const canon = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const local = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
for (const key of ['dependencies', 'devDependencies']) {
  if (JSON.stringify(canon[key]) !== JSON.stringify(local[key])) {
    console.error(`canonical package.json "${key}" differs from showcases/modern-house/package.json; update the child package (and its lock) deliberately first.`);
    process.exit(1);
  }
}

rmSync(join(target, 'src'), { recursive: true, force: true });
rmSync(join(target, 'public', 'assets'), { recursive: true, force: true });
mkdirSync(join(target, 'public'), { recursive: true });
for (const file of ['index.html', 'viggle.html']) cpSync(join(source, file), join(target, file));
cpSync(join(source, 'src'), join(target, 'src'), { recursive: true });
for (const optional of ['public/favicon.svg', 'viggle-provenance.json', 'hybrid-contract.json']) {
  if (existsSync(join(source, optional))) {
    mkdirSync(dirname(join(target, optional)), { recursive: true });
    cpSync(join(source, optional), join(target, optional));
  }
}
let bytes = 0;
for (const rel of [...declared].sort()) {
  const from = join(source, 'public', rel);
  mkdirSync(dirname(join(target, 'public', rel)), { recursive: true });
  cpSync(from, join(target, 'public', rel));
  bytes += statSync(from).size;
}
console.log(`modern-house: synced ${declared.size} assets (${(bytes / 1048576).toFixed(1)} MiB) from ${source}`);
for (const rel of [...declared].sort()) console.log(`  ${rel}`);
